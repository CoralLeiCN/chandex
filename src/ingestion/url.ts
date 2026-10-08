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
export async function fetchPublic(
  input: string,
  redirects = 0,
  expires = Date.now() + 20000,
): Promise<{ bytes: Buffer; url: string; contentType: string }> {
  if (Date.now() >= expires) throw new Error("Source download timed out.");
  if (redirects > 4) throw new Error("Too many redirects.");
  const url = new URL(input);
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
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error("DNS lookup timed out.")),
        Math.max(1, expires - Date.now()),
      );
      t.unref();
    }),
  ]);
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw new Error("Private and reserved network destinations are blocked.");
  const target = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.get(
      url,
      {
        headers: {
          "user-agent": "Codeboom/0.1",
          accept: "text/html,application/pdf,text/plain",
          "accept-encoding": "identity",
        },
        lookup: ((_host: any, _options: any, callback: any) =>
          _options.all
            ? callback(null, [target])
            : callback(null, target.address, target.family)) as any,
        agent: false,
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode)
        ) {
          res.destroy();
          clearTimeout(deadline);
          if (!res.headers.location) {
            reject(new Error("Redirect has no destination."));
            return;
          }
          void fetchPublic(
            new URL(res.headers.location, url).href,
            redirects + 1,
            expires,
          ).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.destroy();
          clearTimeout(deadline);
          reject(new Error("Source returned HTTP " + res.statusCode));
          return;
        }
        if (
          res.headers["content-encoding"] &&
          res.headers["content-encoding"] !== "identity"
        ) {
          res.destroy();
          clearTimeout(deadline);
          reject(new Error("Compressed source response is unsupported."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            req.destroy(new Error("Source exceeds 25 MiB."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        res.on("end", () => {
          clearTimeout(deadline);
          resolve({
            bytes: Buffer.concat(chunks),
            url: url.href,
            contentType: String(res.headers["content-type"] ?? ""),
          });
        });
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("Source download timed out.")),
      Math.max(1, expires - Date.now()),
    );
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}
