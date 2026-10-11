import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIO_MODEL_BYTES,
  AUDIO_MODEL_REVISION,
  audioModelLocation,
  installAudioAssets,
  verifyAudioAssets,
} from "../src/ingestion/audio-assets.ts";
import manifest from "../src/ingestion/audio-model-manifest.json" with { type: "json" };

test("audio model manifest pins every loader asset to one immutable revision", () => {
  assert.match(AUDIO_MODEL_REVISION, /^[a-f0-9]{40}$/);
  assert.equal(manifest.files.length, 13);
  assert.ok(AUDIO_MODEL_BYTES < 48 * 1024 * 1024);
  assert.equal(new Set(manifest.files.map((f) => f.path)).size, 13);
  for (const asset of manifest.files) {
    assert.match(asset.path, /^(?:onnx\/)?[a-z_]+\.(?:json|txt|md|onnx)$/i);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  }
});

test("failed, oversized and corrupt model downloads publish nothing and clean staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeboom-audio-assets-"));
  try {
    await assert.rejects(verifyAudioAssets(root), /missing or damaged/);
    const body = new Uint8Array(manifest.files[0].size);
    const candidates = [
      new Response("failed", { status: 503 }),
      new Response(body, {
        headers: { "content-length": String(body.length + 1) },
      }),
      new Response(new Uint8Array(body.length + 1)),
      new Response(body.subarray(0, body.length - 1)),
      new Response(body),
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/model" },
      }),
      new Response(null, {
        status: 302,
        headers: { location: "http://huggingface.co/model" },
      }),
      new Response(null, { status: 302 }),
    ];
    for (const response of candidates) {
      await assert.rejects(
        installAudioAssets({
          root,
          fetcher: async (url, options) => {
            assert.ok(url.includes("/resolve/" + AUDIO_MODEL_REVISION + "/"));
            assert.equal(options.redirect, "manual");
            return response;
          },
        }),
      );
      assert.deepEqual(await readdir(root), []);
    }
    await assert.rejects(
      installAudioAssets({ root, timeoutMs: 120001 }),
      /deadline/,
    );
    await assert.rejects(
      installAudioAssets({
        root,
        timeoutMs: 5,
        fetcher: async () => new Promise(() => {}),
      }),
      /deadline/,
    );
    await assert.rejects(
      installAudioAssets({
        root,
        timeoutMs: 5,
        fetcher: async () => new Response(new ReadableStream({ start() {} })),
      }),
      /deadline/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing damaged assets are refused without downloading or replacing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeboom-audio-assets-"));
  const { modelPath } = audioModelLocation(root);
  try {
    await mkdir(modelPath, { recursive: true });
    await writeFile(join(modelPath, "private-marker"), "keep this");
    let fetches = 0;
    await assert.rejects(
      installAudioAssets({
        root,
        fetcher: async () => {
          fetches++;
          return new Response("wrong");
        },
      }),
      /Existing transcription assets failed/,
    );
    assert.equal(fetches, 0);
    assert.equal(
      await readFile(join(modelPath, "private-marker"), "utf8"),
      "keep this",
    );
    assert.deepEqual(await readdir(root), [AUDIO_MODEL_REVISION]);
    await assert.rejects(verifyAudioAssets(root), /missing or damaged/);
    await rm(modelPath, { recursive: true });
    await symlink(root, modelPath);
    await assert.rejects(verifyAudioAssets(root), /missing or damaged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
