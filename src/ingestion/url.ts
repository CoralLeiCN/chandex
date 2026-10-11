import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
export const MAX_BYTES = 25 * 1024 * 1024;
export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
interface FetchDependencies {
  resolve: (hostname: string) => Promise<{ address: string; family: number }[]>;
  request: (
    url: URL,
    options: http.RequestOptions,
    response: (res: http.IncomingMessage) => void,
  ) => http.ClientRequest;
}
const network: FetchDependencies = {
  resolve: (hostname) => lookup(hostname, { all: true }),
  request: (url, options, response) =>
    (url.protocol === "https:" ? https : http).get(url, options, response),
};

// The dependency seam exercises DNS/redirect faults without contacting private
// destinations. Production always uses the resolver and transports above.
export function createPublicFetcher(
  dependencies: FetchDependencies = network,
  policy: { maxBytes?: number; allowedURL?: (url: URL) => boolean } = {},
) {
  const maxBytes = policy.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    throw Error("Invalid public download byte limit.");
  const byteError =
    maxBytes === MAX_BYTES
      ? "Source exceeds 25 MiB."
      : "Source exceeds its download byte limit.";
  async function fetchPublic(
    input: string,
    redirects = 0,
    expires = Date.now() + 20000,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Buffer;
    url: string;
    contentType: string;
    retrievedAt: string;
  }> {
    if (signal?.aborted) throw new Error("Source download cancelled.");
    if (Date.now() >= expires) throw new Error("Source download timed out.");
    if (redirects > 4) throw new Error("Too many redirects.");
    const url = new URL(input);
    if (policy.allowedURL && !policy.allowedURL(url))
      throw Error(
        "Source download destination is outside its allowed endpoints.",
      );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Only public HTTP(S) URLs without credentials are supported.",
      );
    if (url.port && !["80", "443"].includes(url.port))
      throw new Error("Only standard web ports are supported.");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let dnsTimer: NodeJS.Timeout | undefined;
    let abortLookup: (() => void) | undefined;
    let addresses: { address: string; family: number }[];
    try {
      addresses = await Promise.race([
        dependencies.resolve(hostname),
        new Promise<never>((_, reject) => {
          dnsTimer = setTimeout(
            () => reject(new Error("DNS lookup timed out.")),
            Math.max(1, expires - Date.now()),
          );
          abortLookup = () => reject(new Error("Source download cancelled."));
          signal?.addEventListener("abort", abortLookup, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(dnsTimer);
      if (abortLookup) signal?.removeEventListener("abort", abortLookup);
    }
    if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
      throw new Error("Private and reserved network destinations are blocked.");
    const target = addresses[0];
    return new Promise((resolve, reject) => {
      let req: http.ClientRequest | undefined;
      const deadline = setTimeout(
        () => {
          const error = new Error("Source download timed out.");
          req?.destroy(error);
          reject(error);
        },
        Math.max(1, expires - Date.now()),
      );
      const fail = (error: Error) => {
        clearTimeout(deadline);
        reject(error);
      };
      try {
        req = dependencies.request(
          url,
          {
            headers: {
              "user-agent": "Codeboom/0.1",
              accept: "text/html,application/pdf,text/plain",
              "accept-encoding": "identity",
            },
            lookup: ((_host: any, options: any, callback: any) =>
              options.all
                ? callback(null, [target])
                : callback(null, target.address, target.family)) as any,
            agent: false,
            signal,
          },
          (res) => {
            res.on("error", fail);
            if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
              res.destroy();
              clearTimeout(deadline);
              if (!res.headers.location) {
                fail(new Error("Redirect has no destination."));
                return;
              }
              // Invalid Location must reject the import, never escape the HTTP
              // callback and terminate the whole application.
              try {
                void fetchPublic(
                  new URL(res.headers.location, url).href,
                  redirects + 1,
                  expires,
                  signal,
                ).then(resolve, reject);
              } catch {
                fail(new Error("Redirect has an invalid destination."));
              }
              return;
            }
            if (res.statusCode !== 200) {
              res.destroy();
              fail(new Error("Source returned HTTP " + res.statusCode));
              return;
            }
            if (
              res.headers["content-encoding"] &&
              res.headers["content-encoding"] !== "identity"
            ) {
              res.destroy();
              fail(new Error("Compressed source response is unsupported."));
              return;
            }
            const length = res.headers["content-length"];
            if (length !== undefined && Number(length) > maxBytes) {
              res.destroy();
              fail(new Error(byteError));
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                const error = new Error(byteError);
                fail(error);
                req?.destroy(error);
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.on("aborted", () =>
              fail(new Error("Source download was interrupted.")),
            );
            res.on("end", () => {
              clearTimeout(deadline);
              resolve({
                bytes: Buffer.concat(chunks),
                url: url.href,
                contentType: String(res.headers["content-type"] ?? ""),
                retrievedAt: new Date().toISOString(),
              });
            });
          },
        );
        req.on("error", fail);
      } catch (error) {
        fail(
          error instanceof Error ? error : new Error("Source download failed."),
        );
      }
    });
  }
  return fetchPublic;
}
export const fetchPublic = createPublicFetcher();
