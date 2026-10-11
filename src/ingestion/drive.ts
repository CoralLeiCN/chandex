import { createHash } from "node:crypto";
import { fileType } from "../domain/source-types.ts";
import { MAX_BYTES } from "./url.ts";
import type { DriveProvenance } from "../domain/drive-provenance.ts";

export const DRIVE_EXPORT_LIMIT = 10_000_000;
const METADATA_LIMIT = 256 * 1024;
const API = "https://www.googleapis.com/drive/v3/files/";
const fields =
  "id,name,mimeType,version,modifiedTime,trashed,size,md5Checksum,capabilities(canDownload)";
const nativeTypes = {
  "application/vnd.google-apps.document": {
    kind: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    path: "document",
  },
  "application/vnd.google-apps.spreadsheet": {
    kind: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    path: "spreadsheets",
  },
  "application/vnd.google-apps.presentation": {
    kind: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    path: "presentation",
  },
} as const;
const binaryTypes: Record<string, readonly string[]> = {
  pdf: ["application/pdf"],
  image: ["image/png", "image/jpeg", "image/webp"],
  audio: [
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/vnd.wave",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/aac",
    "audio/aacp",
    "audio/flac",
    "audio/x-flac",
    "audio/ogg",
    "application/ogg",
    "audio/opus",
  ],
  text: ["text/plain"],
  markdown: ["text/plain", "text/markdown", "text/x-markdown"],
  csv: ["text/csv", "application/csv"],
  tsv: ["text/tab-separated-values", "text/plain"],
  srt: ["application/x-subrip", "text/plain"],
  vtt: ["text/vtt", "text/plain"],
  docx: [nativeTypes["application/vnd.google-apps.document"].mime],
  xlsx: [nativeTypes["application/vnd.google-apps.spreadsheet"].mime],
  pptx: [nativeTypes["application/vnd.google-apps.presentation"].mime],
};
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
export interface DriveFileInput {
  fileId: string;
  resourceKey?: string;
  expectedMime?: string;
}
export function driveFileInput(input: string): DriveFileInput {
  if (typeof input !== "string" || input.length > 4000)
    throw Error("Invalid Google Drive file link or ID.");
  const value = input.trim();
  if (idPattern.test(value)) return { fileId: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("Use a Google Drive, Docs, Sheets or Slides file link or ID.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["drive.google.com", "docs.google.com"].includes(url.hostname)
  )
    throw Error(
      "Use an HTTPS Google Drive, Docs, Sheets or Slides file link without credentials.",
    );
  let fileId: string | undefined, expectedMime: string | undefined;
  if (url.hostname === "drive.google.com") {
    const path =
      /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/(?:view|edit|preview))?\/?$/.exec(
        url.pathname,
      );
    if (path) fileId = path[1];
    else if (
      ["/open", "/uc"].includes(url.pathname) &&
      url.searchParams.getAll("id").length === 1
    )
      fileId = url.searchParams.get("id")!;
  } else {
    const path =
      /^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/(?:edit|view|preview))?\/?$/.exec(
        url.pathname,
      );
    if (path && path[2] !== "e") {
      fileId = path[2];
      expectedMime = Object.entries(nativeTypes).find(
        ([, type]) => type.path === path[1],
      )![0];
    }
  }
  if (!fileId || !idPattern.test(fileId))
    throw Error(
      "Use a supported Google file link; folders, published pages and shortcuts are not followed.",
    );
  const keys = url.searchParams.getAll("resourcekey");
  if (keys.length > 1 || (keys.length === 1 && !idPattern.test(keys[0])))
    throw Error("Invalid Google Drive resource key.");
  if (
    ["access_token", "token", "code"].some((key) => url.searchParams.has(key))
  )
    throw Error(
      "Google Drive file links must not contain authorization credentials.",
    );
  return {
    fileId,
    ...(keys.length ? { resourceKey: keys[0] } : {}),
    ...(expectedMime ? { expectedMime } : {}),
  };
}
interface DriveMetadata {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  modifiedTime: string;
  size?: string;
  md5Checksum?: string;
}
export interface DriveSnapshot {
  bytes: Buffer;
  kind: string;
  name: string;
  origin: string;
  retrievedAt: string;
  provenance: DriveProvenance;
  warnings: string[];
}
type DriveTransport = (url: string, options: RequestInit) => Promise<Response>;
type TokenSupplier = (signal: AbortSignal) => Promise<string>;
function nativeType(mime: string) {
  return Object.hasOwn(nativeTypes, mime)
    ? nativeTypes[mime as keyof typeof nativeTypes]
    : undefined;
}
function validModifiedTime(value: string) {
  const match =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|([+-])(\d\d):(\d\d))$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (match[7] === "Z" || (Number(match[9]) <= 23 && Number(match[10]) <= 59))
  );
}
function metadata(value: unknown, input: DriveFileInput): DriveMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Google Drive metadata is invalid.");
  const v = value as Record<string, any>;
  if (
    v.id !== input.fileId ||
    typeof v.name !== "string" ||
    !v.name.trim() ||
    v.name.length > 1000 ||
    /[\x00-\x1f\x7f]/.test(v.name) ||
    typeof v.mimeType !== "string" ||
    v.mimeType.length > 200 ||
    typeof v.version !== "string" ||
    !/^\d{1,64}$/.test(v.version) ||
    typeof v.modifiedTime !== "string" ||
    !validModifiedTime(v.modifiedTime)
  )
    throw Error("Google Drive identity, name or version metadata is invalid.");
  if (v.trashed !== false || v.capabilities?.canDownload !== true)
    throw Error(
      "This Google Drive file is trashed, unavailable or cannot be downloaded.",
    );
  if (input.expectedMime && v.mimeType !== input.expectedMime)
    throw Error("The Google file type does not match its selected link.");
  const native = nativeType(v.mimeType),
    binary = fileType(v.name);
  if (
    !native &&
    (!binary ||
      (v.mimeType !== "application/octet-stream" &&
        !binaryTypes[binary.kind]?.includes(v.mimeType)))
  )
    throw Error(
      "This Google Drive file type is unsupported. Folders and shortcuts are not imported.",
    );
  if (
    !native &&
    (typeof v.size !== "string" ||
      !/^\d{1,20}$/.test(v.size) ||
      BigInt(v.size) < 1n ||
      BigInt(v.size) > BigInt(MAX_BYTES) ||
      typeof v.md5Checksum !== "string" ||
      !/^[a-fA-F0-9]{32}$/.test(v.md5Checksum))
  )
    throw Error(
      "Google Drive binary size or checksum is missing, invalid or exceeds 25 MiB.",
    );
  return {
    id: v.id,
    name: v.name,
    mimeType: v.mimeType,
    version: v.version,
    modifiedTime: v.modifiedTime,
    ...(!native
      ? { size: v.size, md5Checksum: v.md5Checksum.toLowerCase() }
      : {}),
  };
}
function abortError(signal: AbortSignal, external?: AbortSignal) {
  return Error(
    external?.aborted
      ? "Google Drive retrieval cancelled."
      : "Google Drive retrieval exceeded its deadline.",
  );
}
// Consume even late dependency rejection, remove listeners, and never expose
// provider/transport errors (which can contain credentials or selected text).
function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  external?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal, external));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, () =>
        reject(
          signal.aborted
            ? abortError(signal, external)
            : Error("Google Drive retrieval failed. Try again or reconnect."),
        ),
      )
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function responseBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
  external?: AbortSignal,
) {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d{1,20}$/.test(length) || BigInt(length) > BigInt(limit))
  ) {
    await response.body?.cancel().catch(() => {});
    throw Error(
      "Google Drive response exceeds its byte limit or has an invalid length.",
    );
  }
  if (!response.body) throw Error("Google Drive returned an empty response.");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await bounded(reader.read(), signal, external);
      if (signal.aborted) throw abortError(signal, external);
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw Error("Google Drive response exceeds its byte limit.");
      parts.push(value);
    }
    if (!size || (length !== null && size !== Number(length)))
      throw Error("Google Drive response is empty or incomplete.");
    return Buffer.concat(parts, size);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class DriveClient {
  constructor(
    private readonly token: TokenSupplier,
    private readonly transport: DriveTransport = fetch,
  ) {}
  async retrieve(
    value: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DriveSnapshot> {
    const input = driveFileInput(value),
      timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
      throw Error("Google Drive deadline must be between 1 and 30,000 ms.");
    const deadline = AbortSignal.timeout(timeout),
      signal = options.signal
        ? AbortSignal.any([options.signal, deadline])
        : deadline;
    if (signal.aborted) throw abortError(signal, options.signal);
    let pendingToken: Promise<string>;
    try {
      pendingToken = this.token(signal);
    } catch {
      throw Error("Google Drive authorization is unavailable. Reconnect.");
    }
    const access = await bounded(pendingToken, signal, options.signal);
    if (
      typeof access !== "string" ||
      !/^[A-Za-z0-9._~+\/-]{1,8192}={0,2}$/.test(access)
    )
      throw Error("Google Drive authorization is unavailable. Reconnect.");
    const headers = {
      Authorization: "Bearer " + access,
      ...(input.resourceKey
        ? {
            "X-Goog-Drive-Resource-Keys":
              input.fileId + "/" + input.resourceKey,
          }
        : {}),
    };
    const request = async (url: URL, limit: number, mime?: string) => {
      if (signal.aborted) throw abortError(signal, options.signal);
      let pending: Promise<Response>;
      try {
        pending = this.transport(url.href, {
          method: "GET",
          headers: {
            ...headers,
            "Accept-Encoding": "identity",
            Accept: mime ?? "application/json",
          },
          redirect: "manual",
          signal,
        });
      } catch {
        throw Error("Google Drive retrieval failed. Try again or reconnect.");
      }
      // A dependency that ignores abort must still release a late response.
      void pending.then(
        (response) => {
          if (signal.aborted) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await bounded(pending, signal, options.signal);
      if (
        response.redirected ||
        (response.url && response.url !== url.href) ||
        (response.status >= 300 && response.status < 400)
      ) {
        void response.body?.cancel().catch(() => {});
        throw Error("Google Drive redirects are not supported.");
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw Error(
          response.status === 401
            ? "Google Drive authorization expired. Reconnect."
            : response.status === 403
              ? "Google Drive denied access or downloading. Check the connection and file permission."
              : response.status === 404
                ? "Google Drive file was not found or is unavailable to this connection."
                : response.status === 429
                  ? "Google Drive is rate limited. Wait and retry."
                  : "Google Drive retrieval failed. Try again later.",
        );
      }
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding.toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => {});
        throw Error("Google Drive returned an unsupported transport encoding.");
      }
      const type = response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      if (
        mime
          ? type !== mime && type !== "application/octet-stream"
          : type !== "application/json"
      ) {
        void response.body?.cancel().catch(() => {});
        throw Error("Google Drive returned an unexpected content type.");
      }
      return responseBytes(response, limit, signal, options.signal);
    };
    const metadataURL = new URL(API + input.fileId);
    metadataURL.searchParams.set("fields", fields);
    metadataURL.searchParams.set("supportsAllDrives", "true");
    const readMetadata = async () => {
      const bytes = await request(metadataURL, METADATA_LIMIT);
      try {
        return metadata(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          input,
        );
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError)
          throw Error("Google Drive metadata is invalid UTF-8 or JSON.");
        throw error;
      }
    };
    const before = await readMetadata(),
      native = nativeType(before.mimeType),
      kind = native?.kind ?? fileType(before.name)!.kind;
    const contentURL = new URL(API + input.fileId + (native ? "/export" : ""));
    if (native) contentURL.searchParams.set("mimeType", native.mime);
    else {
      contentURL.searchParams.set("alt", "media");
      contentURL.searchParams.set("supportsAllDrives", "true");
    }
    const bytes = await request(
      contentURL,
      native ? DRIVE_EXPORT_LIMIT : MAX_BYTES,
      native?.mime ?? before.mimeType,
    );
    if (
      !native &&
      (bytes.length !== Number(before.size) ||
        createHash("md5").update(bytes).digest("hex") !== before.md5Checksum)
    )
      throw Error(
        "Google Drive binary content does not match its size or checksum.",
      );
    const after = await readMetadata();
    if (JSON.stringify(after) !== JSON.stringify(before))
      throw Error(
        "The Google Drive file changed during retrieval. Retry to capture one version.",
      );
    if (signal.aborted) throw abortError(signal, options.signal);
    return {
      bytes,
      kind,
      name: before.name,
      origin: native
        ? `https://docs.google.com/${native.path}/d/${input.fileId}/edit`
        : `https://drive.google.com/file/d/${input.fileId}/view`,
      retrievedAt: new Date().toISOString(),
      provenance: {
        provider: "google-drive",
        ...before,
        ...(native ? { exportMimeType: native.mime } : {}),
        representation: native ? "workspace-export" : "binary",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      warnings: native
        ? [
            "Metadata checked before and after retrieval does not provide a provider-side transaction lock.",
            "Google Workspace content is a retained Office export, not the native document. Layout, formulas and embedded media follow the selected parser's limitations; comments and revision history are not a complete native archive.",
          ]
        : [
            "Google Drive binary size and checksum match its metadata. Metadata checked before and after retrieval does not provide a provider-side transaction lock.",
          ],
    };
  }
}
