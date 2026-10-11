import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type http from "node:http";
import { createPublicFetcher, MAX_BYTES } from "../src/ingestion/url.ts";

type Response = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  aborted?: boolean;
  stalled?: boolean;
};
function fixture(
  responses: Response[],
  resolve = async (_host: string) => [{ address: "1.1.1.1", family: 4 }],
  policy?: Parameters<typeof createPublicFetcher>[1],
) {
  const requests: { url: string; options: http.RequestOptions }[] = [];
  const fetch = createPublicFetcher(
    {
      resolve,
      request(url, options, callback) {
        requests.push({ url: url.href, options });
        const req = new EventEmitter() as http.ClientRequest;
        req.destroy = (error?: Error) => {
          if (error) queueMicrotask(() => req.emit("error", error));
          return req;
        };
        const input = responses.shift();
        assert.ok(input, "unexpected request");
        queueMicrotask(() => {
          const body = new PassThrough();
          const res = body as unknown as http.IncomingMessage;
          res.statusCode = input.status ?? 200;
          res.headers = input.headers ?? { "content-type": "text/plain" };
          callback(res);
          if (res.destroyed || input.stalled) return;
          for (const chunk of input.chunks ?? [Buffer.from("Evidence")])
            body.write(chunk);
          if (input.aborted) res.emit("aborted");
          else body.end();
        });
        return req;
      },
    },
    policy,
  );
  return { fetch, requests };
}

test("restricted public fetchers enforce endpoint and byte policy before DNS and after every redirect", async () => {
  let resolutions = 0;
  const f = fixture(
    [
      {
        status: 302,
        headers: { location: "https://foreign.example/captions" },
      },
    ],
    async () => {
      resolutions++;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    { maxBytes: 4, allowedURL: (u) => u.hostname === "allowed.example" },
  );
  await assert.rejects(
    f.fetch("https://allowed.example/watch"),
    /allowed endpoints/,
  );
  assert.equal(resolutions, 1);
  assert.equal(f.requests.length, 1);
  const oversized = fixture(
    [{ chunks: [Buffer.from("123"), Buffer.from("45")] }],
    undefined,
    { maxBytes: 4 },
  );
  await assert.rejects(
    oversized.fetch("https://allowed.example"),
    /byte limit/,
  );
  const declared = fixture(
    [{ headers: { "content-length": "5" } }],
    undefined,
    { maxBytes: 4 },
  );
  await assert.rejects(declared.fetch("https://allowed.example"), /byte limit/);
  assert.throws(
    () => createPublicFetcher(undefined, { maxBytes: 0 }),
    /Invalid/,
  );
});

test("every redirect is resolved again; relative locations preserve final provenance", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const resolutions: string[] = [];
    const f = fixture(
      [{ status, headers: { location: "../final" } }, {}],
      async (host) => {
        resolutions.push(host);
        return [{ address: "1.1.1.1", family: 4 }];
      },
    );
    const result = await f.fetch("https://public.example/path/start");
    assert.equal(result.url, "https://public.example/final");
    assert.equal(result.bytes.toString(), "Evidence");
    assert.deepEqual(resolutions, ["public.example", "public.example"]);
    assert.equal(f.requests.length, 2);
  }
});

test("mixed/private DNS results and redirected DNS rebinding never reach a transport", async () => {
  for (const addresses of [
    [],
    [{ address: "10.1.2.3", family: 4 }],
    [
      { address: "1.1.1.1", family: 4 },
      { address: "::1", family: 6 },
    ],
    [{ address: "::ffff:169.254.169.254", family: 6 }],
  ]) {
    const f = fixture([], async () => addresses);
    await assert.rejects(f.fetch("https://public.example"), /blocked/);
    assert.equal(f.requests.length, 0);
  }
  let lookups = 0;
  const f = fixture(
    [{ status: 302, headers: { location: "/rebound" } }],
    async () => [
      { address: ++lookups === 1 ? "1.1.1.1" : "127.0.0.1", family: 4 },
    ],
  );
  await assert.rejects(f.fetch("https://public.example"), /blocked/);
  assert.equal(lookups, 2);
  assert.equal(f.requests.length, 1);
});

test("transport lookup pins the validated address while retaining hostname for TLS", async () => {
  const f = fixture([{}]);
  await f.fetch("https://public.example");
  const { url, options } = f.requests[0];
  assert.equal(url, "https://public.example/");
  assert.equal(options.agent, false);
  const pinned = options.lookup as Function;
  pinned(
    "public.example",
    {},
    (error: Error | null, ip: string, family: number) => {
      assert.equal(error, null);
      assert.equal(ip, "1.1.1.1");
      assert.equal(family, 4);
    },
  );
  pinned(
    "public.example",
    { all: true },
    (error: Error | null, addresses: unknown) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: "1.1.1.1", family: 4 }]);
    },
  );
});

test("redirects reject malformed locations, credentials, private hosts, schemes and ports", async () => {
  for (const location of [
    "http://[invalid",
    "https://user:password@public.example",
    "file:///etc/passwd",
    "https://public.example:444",
    "http://127.0.0.1",
    "http://2130706433",
  ]) {
    const f = fixture(
      [{ status: 302, headers: { location } }],
      async (host) => [
        { address: host === "127.0.0.1" ? "127.0.0.1" : "1.1.1.1", family: 4 },
      ],
    );
    await assert.rejects(f.fetch("https://public.example"));
    assert.equal(f.requests.length, 1, location);
  }
  const missing = fixture([{ status: 302, headers: {} }]);
  await assert.rejects(
    missing.fetch("https://public.example"),
    /no destination/,
  );
  const loop = fixture(
    Array.from({ length: 5 }, () => ({
      status: 302,
      headers: { location: "/loop" },
    })),
  );
  await assert.rejects(
    loop.fetch("https://public.example"),
    /Too many redirects/,
  );
  assert.equal(loop.requests.length, 5);
});

test("downloads reject HTTP errors, compressed bodies, oversized declarations and streams", async () => {
  const cases: [Response, RegExp][] = [
    [{ status: 404 }, /HTTP 404/],
    [{ headers: { "content-encoding": "gzip" } }, /Compressed/],
    [{ headers: { "content-length": String(MAX_BYTES + 1) } }, /25 MiB/],
    [{ chunks: [Buffer.alloc(MAX_BYTES), Buffer.from("x")] }, /25 MiB/],
    [{ aborted: true }, /interrupted/],
  ];
  for (const [response, error] of cases)
    await assert.rejects(
      fixture([response]).fetch("https://public.example"),
      error,
    );
});

test("one deadline bounds DNS, stalled responses and the entire redirect chain", async () => {
  const dns = fixture([], () => new Promise(() => {}));
  await assert.rejects(
    dns.fetch("https://public.example", 0, Date.now() + 20),
    /DNS lookup timed out/,
  );
  const stalled = fixture([{ stalled: true }]);
  await assert.rejects(
    stalled.fetch("https://public.example", 0, Date.now() + 20),
    /download timed out/,
  );
  const expired = fixture([]);
  await assert.rejects(
    expired.fetch("https://public.example", 0, Date.now() - 1),
    /download timed out/,
  );
  assert.equal(expired.requests.length, 0);
  let resolutions = 0;
  const chain = fixture(
    [{ status: 302, headers: { location: "/next" } }],
    async () => {
      if (++resolutions > 1) return new Promise(() => {});
      return [{ address: "1.1.1.1", family: 4 }];
    },
  );
  await assert.rejects(
    chain.fetch("https://public.example", 0, Date.now() + 30),
    /timed out/,
  );
  assert.equal(chain.requests.length, 1);
});

test("cancelled DNS work rejects promptly and completed snapshots record retrieval time", async () => {
  const controller = new AbortController();
  const dns = fixture([], () => new Promise(() => {}));
  const pending = dns.fetch(
    "https://public.example",
    0,
    Date.now() + 20000,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(dns.requests.length, 0);
  const downloaded = await fixture([{}]).fetch("https://public.example");
  assert.ok(Number.isFinite(Date.parse(downloaded.retrievedAt)));
});
