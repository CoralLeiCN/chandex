import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface AacModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  getValue(pointer: number, type: "i32" | "i8"): number;
  _malloc(length: number): number;
  _free(pointer: number): void;
  _aac_create(): number;
  _aac_init(
    handle: number,
    pointer: number,
    length: number,
    rate: number,
    channels: number,
  ): number;
  _aac_init2(
    handle: number,
    pointer: number,
    length: number,
    rate: number,
    channels: number,
  ): number;
  _aac_sr_ptr(): number;
  _aac_ch_ptr(): number;
  _aac_decode(handle: number, pointer: number, length: number): number;
  _aac_error(): number;
  _aac_consumed(): number;
  _aac_samples(): number;
  _aac_samplerate(): number;
  _aac_channels(): number;
  _aac_close(handle: number): void;
  _aac_free_buf(): void;
}
const failure = () =>
  new Error(
    "AAC decoding failed or returned incomplete audio. Nothing was imported.",
  );

// Own the bridge to the pinned engine's exported C ABI. The upstream wrapper
// conflates a valid zero-sample priming packet with a codec error, and hides
// errors entirely when every packet in a call has no output.
export async function createAacDecoder(config: {
  asc?: Buffer;
  firstAdts?: Buffer;
}) {
  const require = createRequire(import.meta.url);
  const enginePath = join(
    dirname(require.resolve("@audio/decode-aac")),
    "src/aac.wasm.js",
  );
  const { default: create } = await import(pathToFileURL(enginePath).href);
  const module: AacModule = await create({
    print: () => {},
    printErr: () => {},
  });
  for (const name of [
    "_aac_create",
    "_aac_init",
    "_aac_init2",
    "_aac_error",
    "_aac_consumed",
    "_aac_decode",
    "_aac_samples",
    "_aac_channels",
    "_aac_samplerate",
    "_aac_close",
    "_aac_free_buf",
    "_aac_sr_ptr",
    "_aac_ch_ptr",
    "_malloc",
    "_free",
    "getValue",
  ])
    if (
      typeof (module as unknown as Record<string, unknown>)[name] !== "function"
    )
      throw failure();
  const handle = module._aac_create();
  if (!handle) throw failure();
  let pointer = 0,
    capacity = 0,
    closed = false;
  const load = (bytes: Buffer) => {
    if (!bytes.length || bytes.length > 65536) throw failure();
    if (bytes.length > capacity) {
      if (pointer) module._free(pointer);
      pointer = module._malloc(bytes.length);
      capacity = bytes.length;
      if (!pointer) throw failure();
    }
    module.HEAPU8.set(bytes, pointer);
  };
  const free = () => {
    if (closed) return;
    closed = true;
    module._aac_close(handle);
    module._aac_free_buf();
    if (pointer) module._free(pointer);
  };
  try {
    const bytes = config.asc ?? config.firstAdts;
    if (!bytes) throw failure();
    load(bytes);
    const status = config.asc
      ? module._aac_init2(
          handle,
          pointer,
          bytes.length,
          module._aac_sr_ptr(),
          module._aac_ch_ptr(),
        )
      : module._aac_init(
          handle,
          pointer,
          bytes.length,
          module._aac_sr_ptr(),
          module._aac_ch_ptr(),
        );
    if (status < 0 || (!config.asc && status !== 0)) throw failure();
  } catch (error) {
    free();
    throw failure();
  }
  return {
    initialRate: module.getValue(module._aac_sr_ptr(), "i32"),
    initialChannels: module.getValue(module._aac_ch_ptr(), "i8"),
    decode(bytes: Buffer) {
      if (closed) throw failure();
      load(bytes);
      const output = module._aac_decode(handle, pointer, bytes.length);
      const error = module._aac_error(),
        consumed = module._aac_consumed();
      const count = module._aac_samples(),
        channels = module._aac_channels(),
        sampleRate = module._aac_samplerate();
      if (
        error ||
        consumed !== bytes.length ||
        (channels !== 1 && channels !== 2) ||
        count % channels ||
        count > channels * 4096 ||
        (count && !output)
      )
        throw failure();
      const frames = count / channels;
      const channelData = Array.from({ length: channels }, (_, channel) => {
        const result = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame++)
          result[frame] =
            module.HEAPF32[(output >> 2) + frame * channels + channel];
        return result;
      });
      return {
        channelData,
        sampleRate,
        samplesDecoded: frames,
        errors: [] as unknown[],
      };
    },
    free,
  };
}
