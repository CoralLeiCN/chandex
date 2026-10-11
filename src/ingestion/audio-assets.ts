import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import manifest from "./audio-model-manifest.json" with { type: "json" };

export const AUDIO_MODEL = manifest.model;
export const AUDIO_MODEL_REVISION = manifest.revision;
export const AUDIO_MODEL_LANGUAGE = manifest.language;
export const AUDIO_MODEL_BYTES = manifest.files.reduce(
  (n, file) => n + file.size,
  0,
);
export const AUDIO_ASSET_ERROR =
  "The local English transcription model is missing or damaged. Run npm run audio:setup before importing audio.";

export function audioModelRoot() {
  return resolve(process.env.CODEBOOM_AUDIO_MODEL_DIR ?? ".codeboom/models");
}
export function audioModelLocation(root = audioModelRoot()) {
  const localModelPath = join(resolve(root), AUDIO_MODEL_REVISION);
  return { localModelPath, modelPath: join(localModelPath, AUDIO_MODEL) };
}

async function exactFiles(path: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > manifest.files.length)
    throw new Error(AUDIO_ASSET_ERROR);
  for (const entry of entries) {
    const relative = prefix + entry.name;
    if (entry.isDirectory() && !prefix && entry.name === "onnx")
      files.push(...(await exactFiles(join(path, entry.name), relative + "/")));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(AUDIO_ASSET_ERROR);
  }
  return files.sort();
}

async function verifyModelDirectory(modelPath: string) {
  // The loader may inspect optional files. Refuse extra assets as well as
  // mismatched required files, so every possible local input is hash-bound.
  if (!(await lstat(modelPath)).isDirectory())
    throw new Error(AUDIO_ASSET_ERROR);
  const expected = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(await exactFiles(modelPath)) !== JSON.stringify(expected))
    throw new Error(AUDIO_ASSET_ERROR);
  for (const file of manifest.files) {
    const handle = await open(
      join(modelPath, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.size)
        throw new Error(AUDIO_ASSET_ERROR);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > file.size) throw new Error(AUDIO_ASSET_ERROR);
        hash.update(chunk);
      }
      if (size !== file.size || hash.digest("hex") !== file.sha256)
        throw new Error(AUDIO_ASSET_ERROR);
    } finally {
      await handle.close();
    }
  }
}

export async function verifyAudioAssets(root = audioModelRoot()) {
  const location = audioModelLocation(root);
  try {
    // Fixed subdirectories must be real directories, not loader redirects.
    for (const path of [
      location.localModelPath,
      join(location.localModelPath, "onnx-community"),
    ])
      if (!(await lstat(path)).isDirectory())
        throw new Error(AUDIO_ASSET_ERROR);
    await verifyModelDirectory(location.modelPath);
    return location;
  } catch {
    throw new Error(AUDIO_ASSET_ERROR);
  }
}

type AssetFetch = (url: string, options: RequestInit) => Promise<Response>;
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new Error("Transcription model download exceeded its deadline."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, (error) =>
        reject(
          signal.aborted
            ? new Error("Transcription model download exceeded its deadline.")
            : error,
        ),
      )
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
function allowedDownload(url: URL) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    ["huggingface.co", "hf.co", "xethub.hf.co"].some(
      (host) => url.hostname === host || url.hostname.endsWith("." + host),
    )
  );
}
async function downloadResponse(
  url: string,
  fetcher: AssetFetch,
  signal: AbortSignal,
) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 8; redirects++) {
    if (!allowedDownload(current))
      throw new Error("Unexpected transcription model download destination.");
    const response = await bounded(
      fetcher(current.href, { signal, redirect: "manual" }),
      signal,
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const destination = response.headers.get("location");
      await response.body?.cancel();
      if (!destination)
        throw new Error("Transcription model download redirect is incomplete.");
      current = new URL(destination, current);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Transcription model download failed.");
    }
    return response;
  }
  throw new Error("Too many transcription model download redirects.");
}

export async function installAudioAssets(
  options: {
    root?: string;
    fetcher?: AssetFetch;
    progress?: (path: string) => void;
    timeoutMs?: number;
  } = {},
) {
  const root = resolve(options.root ?? audioModelRoot());
  const { localModelPath } = audioModelLocation(root);
  try {
    await lstat(localModelPath);
    await verifyAudioAssets(root);
    return { installed: false, ...audioModelLocation(root) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Existing transcription assets failed verification. Choose a new CODEBOOM_AUDIO_MODEL_DIR or remove the damaged model directory before setup.",
      );
  }
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error(
      "Model download deadline must be between 1 and 120,000 ms per file.",
    );
  await mkdir(root, { recursive: true });
  const staging = join(root, ".audio-setup-" + randomUUID());
  const modelPath = join(staging, AUDIO_MODEL);
  await mkdir(modelPath, { recursive: true });
  try {
    for (const file of manifest.files) {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await downloadResponse(
        `https://huggingface.co/${AUDIO_MODEL}/resolve/${AUDIO_MODEL_REVISION}/${file.path}`,
        options.fetcher ?? fetch,
        signal,
      );
      const declaration = response.headers.get("content-length");
      if (
        declaration !== null &&
        (!/^\d+$/.test(declaration) || Number(declaration) !== file.size)
      ) {
        await response.body!.cancel();
        throw new Error(
          "Transcription model download size does not match the pinned asset.",
        );
      }
      const destination = join(modelPath, file.path);
      await mkdir(dirname(destination), { recursive: true });
      const handle = await open(destination, "wx", 0o600);
      const reader = response.body!.getReader();
      const hash = createHash("sha256");
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await bounded(reader.read(), signal);
          if (done) break;
          if (signal.aborted)
            throw new Error(
              "Transcription model download exceeded its deadline.",
            );
          size += value.byteLength;
          if (size > file.size)
            throw new Error(
              "Transcription model download exceeds its pinned size.",
            );
          hash.update(value);
          // FileHandle.write may write fewer bytes than requested.
          let offset = 0;
          while (offset < value.byteLength) {
            const written = await handle.write(
              value,
              offset,
              value.byteLength - offset,
            );
            if (!written.bytesWritten)
              throw new Error("Transcription model staging write failed.");
            offset += written.bytesWritten;
          }
        }
        if (signal.aborted)
          throw new Error(
            "Transcription model download exceeded its deadline.",
          );
        if (size !== file.size || hash.digest("hex") !== file.sha256)
          throw new Error(
            "Transcription model download failed size or SHA-256 verification.",
          );
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await handle.close();
      }
      options.progress?.(file.path);
    }
    await verifyModelDirectory(modelPath);
    try {
      await rename(staging, localModelPath);
    } catch (error) {
      if (
        !["ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      // Concurrent setup may have installed the same immutable revision.
      await verifyAudioAssets(root);
      return { installed: false, ...audioModelLocation(root) };
    }
    await verifyAudioAssets(root);
    return { installed: true, ...audioModelLocation(root) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
