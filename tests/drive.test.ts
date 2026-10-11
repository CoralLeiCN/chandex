import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DriveClient,
  driveFileInput,
  DRIVE_EXPORT_LIMIT,
} from "../src/ingestion/drive.ts";
import { extractIsolated } from "../src/ingestion/service.ts";
import {
  wordFixture,
  slidesFixture,
  workbookFixture,
} from "./fixtures/office.ts";

const id = "Synthetic_File-123",
  key = "0-Synthetic-key",
  token = "synthetic-access.token",
  text = Buffer.from("Do not approve £40. Café 🦉.");
const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
const baseMetadata = {
  id,
  name: "Personal notes.txt",
  mimeType: "text/plain",
  version: "90071992547409931234",
  modifiedTime: "2026-10-10T12:34:56.123Z",
  trashed: false,
  capabilities: { canDownload: true },
  size: String(text.length),
  md5Checksum: md5(text),
};
const asMetadata = (value: unknown = baseMetadata) => Response.json(value);
const asContent = (bytes: Buffer = text, mime = "text/plain") =>
  new Response(new Uint8Array(bytes), {
    headers: { "content-type": mime, "content-length": String(bytes.length) },
  });
function fixture(
  responses: (Response | (() => Promise<Response>))[],
  supplier: (signal: AbortSignal) => Promise<string> = async () => token,
) {
  const calls: { url: URL; options: RequestInit }[] = [];
  const client = new DriveClient(supplier, async (input, options) => {
    calls.push({ url: new URL(input), options });
    const response = responses.shift();
    assert.ok(response, "Unexpected Drive request");
    return typeof response === "function" ? response() : response;
  });
  return { client, calls };
}

test("Drive link parsing selects one supported file, preserves resource key only for retrieval and refuses foreign/ambiguous links", () => {
  for (const input of [
    id,
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?export=download&id=${id}`,
  ])
    assert.deepEqual(driveFileInput(input), { fileId: id });
  for (const [path, mime] of [
    ["document", "document"],
    ["spreadsheets", "spreadsheet"],
    ["presentation", "presentation"],
  ]) {
    assert.deepEqual(
      driveFileInput(
        `https://docs.google.com/${path}/d/${id}/edit?resourcekey=${key}#heading=test`,
      ),
      {
        fileId: id,
        resourceKey: key,
        expectedMime: "application/vnd.google-apps." + mime,
      },
    );
    assert.equal(
      driveFileInput(`https://docs.google.com/${path}/u/0/d/${id}/view`).fileId,
      id,
    );
  }
  for (const input of [
    "",
    "http://drive.google.com/file/d/x/view",
    "https://user:secret@drive.google.com/file/d/x/view",
    "https://drive.google.com:9443/file/d/x/view",
    "https://drive.google.com.evil.example/file/d/x/view",
    "https://docs.google.com/document/d/e/published/pub",
    "https://drive.google.com/drive/folders/x",
    "https://drive.google.com/open?id=a&id=b",
    "https://drive.google.com/file/d/x/view?resourcekey=a&resourcekey=b",
    "https://drive.google.com/file/d/x/view?resourcekey=bad%0Akey",
    "https://docs.google.com/document/d/x/edit?access_token=secret",
    "https://docs.google.com/document/d/x/export",
    "x".repeat(4001),
  ])
    assert.throws(() => driveFileInput(input));
});

test("Drive binary retrieval fixes endpoints/auth headers, verifies exact bytes, brackets versions and excludes credentials from provenance", async () => {
  const { client, calls } = fixture([asMetadata(), asContent(), asMetadata()]);
  const result = await client.retrieve(
    `https://drive.google.com/file/d/${id}/view?resourcekey=${key}`,
  );
  assert.equal(result.kind, "text");
  assert.deepEqual(result.bytes, text);
  assert.equal(result.origin, `https://drive.google.com/file/d/${id}/view`);
  assert.equal(result.provenance.version, baseMetadata.version);
  assert.equal(result.provenance.modifiedTime, baseMetadata.modifiedTime);
  assert.equal(
    result.provenance.sha256,
    createHash("sha256").update(text).digest("hex"),
  );
  assert.equal(result.provenance.md5Checksum, md5(text));
  assert.equal(result.provenance.representation, "binary");
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  for (const { url, options } of calls) {
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, `/drive/v3/files/${id}`);
    assert.equal(options.method, "GET");
    assert.equal(
      new Headers(options.headers).get("accept-encoding"),
      "identity",
    );
    assert.equal(options.redirect, "manual");
    assert.equal(
      new Headers(options.headers).get("Authorization"),
      "Bearer " + token,
    );
    assert.equal(
      new Headers(options.headers).get("X-Goog-Drive-Resource-Keys"),
      id + "/" + key,
    );
    assert.equal(url.searchParams.get("supportsAllDrives"), "true");
    assert.ok(!url.href.includes(token) && !url.href.includes(key));
    assert.equal(url.searchParams.has("acknowledgeAbuse"), false);
    assert.equal(options.signal, calls[0].options.signal);
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url.searchParams.get("alt"), "media");
  assert.equal(calls[0].url.href, calls[2].url.href);
  const serialized = JSON.stringify({ ...result, bytes: undefined });
  assert.ok(!serialized.includes(token) && !serialized.includes(key));
  const extracted = await extractIsolated(result.bytes, result.kind);
  assert.equal(extracted.sections[0].text, text.toString());
});

test("native Docs, Sheets and Slides export exact Office snapshots and reuse isolated parser fidelity/locators", async () => {
  for (const [path, native, kind, mime, bytes] of [
    [
      "document",
      "document",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      wordFixture(),
    ],
    [
      "spreadsheets",
      "spreadsheet",
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbookFixture(),
    ],
    [
      "presentation",
      "presentation",
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      slidesFixture(),
    ],
  ] as const) {
    const info = {
      ...baseMetadata,
      name: "Workspace note 🦉",
      mimeType: "application/vnd.google-apps." + native,
      size: undefined,
      md5Checksum: undefined,
    };
    const { client, calls } = fixture([
      asMetadata(info),
      asContent(bytes, mime),
      asMetadata(info),
    ]);
    const result = await client.retrieve(
      `https://docs.google.com/${path}/d/${id}/edit`,
    );
    assert.equal(result.kind, kind);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.provenance.exportMimeType, mime);
    assert.equal(result.provenance.representation, "workspace-export");
    assert.equal(result.provenance.size, undefined);
    assert.match(result.warnings.join(" "), /not the native/);
    assert.equal(calls[1].url.pathname, `/drive/v3/files/${id}/export`);
    assert.equal(calls[1].url.searchParams.get("mimeType"), mime);
    assert.equal(calls[1].url.searchParams.has("alt"), false);
    const parsed = await extractIsolated(result.bytes, result.kind);
    assert.ok(parsed.sections.length);
    assert.ok(parsed.warnings.length);
  }
});

test("Drive metadata failures stop before content retrieval, including restrictions, shortcuts, bad identity, limits and prototype-like MIME", async () => {
  for (const patch of [
    { id: "Foreign" },
    { name: "" },
    { name: "secret\nname.txt" },
    { name: "a".repeat(1001) },
    { version: 42 },
    { version: "invalid" },
    { modifiedTime: "unknown" },
    { modifiedTime: "2026-02-30T12:00:00Z" },
    { modifiedTime: "2025-02-29T12:00:00Z" },
    { modifiedTime: "2026-99-99T99:99:99Z" },
    { trashed: true },
    { trashed: undefined },
    { capabilities: {} },
    { capabilities: { canDownload: false } },
    { mimeType: "application/vnd.google-apps.shortcut" },
    { mimeType: "application/vnd.google-apps.folder" },
    { mimeType: "application/vnd.google-apps.form" },
    { mimeType: "toString" },
    { mimeType: "image/png" },
    { name: "legacy.doc" },
    { size: "0" },
    { size: String(25 * 1024 * 1024 + 1) },
    { size: "1e5" },
    { md5Checksum: undefined },
    { md5Checksum: "bad" },
  ]) {
    const { client, calls } = fixture([
      asMetadata({ ...baseMetadata, ...patch }),
    ]);
    await assert.rejects(client.retrieve(id));
    assert.equal(calls.length, 1);
  }
  const wrong = fixture([asMetadata()]);
  await assert.rejects(
    wrong.client.retrieve(`https://docs.google.com/document/d/${id}/edit`),
    /type.*match/,
  );
  for (const response of [
    Response.json(null),
    Response.json([]),
    new Response(Buffer.from([0xff]), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{bad", { headers: { "content-type": "application/json" } }),
  ])
    await assert.rejects(fixture([response]).client.retrieve(id), /metadata/);
});

test("Drive download restrictions and hostile transport errors never echo provider bodies, tokens or locations", async () => {
  for (const [status, message] of [
    [401, /authorization expired/],
    [403, /denied access/],
    [404, /not found/],
    [429, /rate limited/],
    [500, /failed/],
  ] as const) {
    const f = fixture([new Response("private-content " + token, { status })]);
    await assert.rejects(f.client.retrieve(id), (error) => {
      assert.match((error as Error).message, message);
      assert.ok(!(error as Error).message.includes(token));
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
  let cancelled = false;
  const redirect = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 302, headers: { location: "https://foreign.example/" + token } },
  );
  await assert.rejects(fixture([redirect]).client.retrieve(id), /redirects/);
  assert.equal(cancelled, true);
  for (const source of [
    new DriveClient(
      async () => token,
      async () => {
        throw Error(token);
      },
    ),
    new DriveClient(async () => {
      throw Error(token);
    }),
    new DriveClient(() => {
      throw Error(token);
    }),
    new DriveClient(async () => "bad\nheader"),
  ])
    await assert.rejects(source.retrieve(id), (error) => {
      assert.ok(!(error as Error).message.includes(token));
      return true;
    });
  const response = new Response("private");
  Object.defineProperty(response, "url", { value: "https://foreign.example" });
  await assert.rejects(fixture([response]).client.retrieve(id), /redirects/);
});

test("Drive streams reject empty, truncated, oversized, mismatched content and changes after retrieval without returning a snapshot", async () => {
  for (const response of [
    new Response("", { headers: { "content-type": "text/plain" } }),
    new Response("tiny", {
      headers: { "content-type": "text/plain", "content-length": "99" },
    }),
    new Response("tiny", { headers: { "content-type": "text/html" } }),
    asContent(Buffer.from("Wrong text")),
    new Response("tiny", {
      headers: {
        "content-type": "text/plain",
        "content-length": String(25 * 1024 * 1024 + 1),
      },
    }),
    new Response("tiny", {
      headers: { "content-type": "text/plain", "content-length": "invalid" },
    }),
  ])
    await assert.rejects(fixture([asMetadata(), response]).client.retrieve(id));
  await assert.rejects(
    fixture([
      asMetadata(),
      new Response("compressed", {
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
      }),
    ]).client.retrieve(id),
    /transport encoding/,
  );
  const metadataOverflow = new Response("x".repeat(256 * 1024 + 1), {
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    fixture([metadataOverflow]).client.retrieve(id),
    /byte limit/,
  );
  for (const patch of [
    { version: "90071992547409931235" },
    { name: "Renamed.txt" },
    { modifiedTime: "2026-10-10T12:35:00Z" },
    { md5Checksum: "a".repeat(32) },
    { size: String(text.length + 1) },
    { capabilities: { canDownload: false } },
    { trashed: true },
  ])
    await assert.rejects(
      fixture([
        asMetadata(),
        asContent(),
        asMetadata({ ...baseMetadata, ...patch }),
      ]).client.retrieve(id),
    );
  const native = {
    ...baseMetadata,
    mimeType: "application/vnd.google-apps.document",
  };
  const large = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(DRIVE_EXPORT_LIMIT));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    }),
    {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    },
  );
  await assert.rejects(
    fixture([asMetadata(native), large]).client.retrieve(id),
    /byte limit/,
  );
});

test("one Drive deadline covers token, metadata, content and final version check; cancellation cleans late responses and makes no subsequent requests", async () => {
  const c = new AbortController();
  c.abort();
  let tokens = 0;
  const pre = new DriveClient(async () => {
    tokens++;
    return token;
  });
  await assert.rejects(pre.retrieve(id, { signal: c.signal }), /cancelled/);
  assert.equal(tokens, 0);
  for (const at of [0, 1, 2, 3]) {
    let unstall: (response: Response) => void = () => {},
      lateCancelled = false;
    const waiting = new Promise<Response>((resolve) => {
      unstall = resolve;
    });
    const responses = [asMetadata(), asContent(), asMetadata()];
    const supplier =
      at === 0 ? async () => new Promise<string>(() => {}) : async () => token;
    const f = fixture(
      responses.map((value, index) =>
        index === at - 1 ? () => waiting : value,
      ),
      supplier,
    );
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(
        f.client.retrieve(id, { timeoutMs: 10 }),
        /deadline/,
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(f.calls.length, at);
    unstall(
      new Response(
        new ReadableStream({
          cancel() {
            lateCancelled = true;
          },
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    if (at) assert.equal(lateCancelled, true);
  }
  const abort = new AbortController();
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let streamCancelled = false;
  const stalled = new Response(
    new ReadableStream({
      start() {
        ready();
      },
      cancel() {
        streamCancelled = true;
      },
    }),
    { headers: { "content-type": "text/plain" } },
  );
  const f = fixture([asMetadata(), stalled]);
  const pending = f.client.retrieve(id, { signal: abort.signal });
  await started;
  // Wait until content is requested so the abort covers a pending body read.
  while (f.calls.length < 2)
    await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.calls.length, 2);
  assert.equal(streamCancelled, true);
  for (const timeoutMs of [0, NaN, 30001])
    await assert.rejects(
      new DriveClient(async () => token).retrieve(id, { timeoutMs }),
      /deadline/,
    );
});
