import { AUDIO_TARGET_RATE, checkAudioParameters } from "./audio-limits.ts";
import { MAX_BYTES } from "./url.ts";

export interface DecodedAudio {
  mono: Float32Array;
  sampleRate: number;
  channels: number;
  warnings: string[];
}
export function decodeWav(bytes: Buffer): DecodedAudio {
  const invalid = () => {
    throw new Error(
      "Malformed, truncated or unsupported WAV recording. Use a complete PCM or IEEE-float WAV file.",
    );
  };
  if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 25 MiB.");
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    invalid();
  let format: Buffer | undefined,
    data: Buffer | undefined,
    chunks = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (++chunks > 10000 || offset + 8 > bytes.length) invalid();
    const name = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + size + (size % 2);
    if (next > bytes.length) invalid();
    const content = bytes.subarray(offset + 8, offset + 8 + size);
    if (name === "fmt ") {
      if (format) invalid();
      format = content;
    }
    if (name === "data") {
      if (data) invalid();
      data = content;
    }
    offset = next;
  }
  if (!format || !data || format.length < 16) return invalid();
  let codec = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2),
    rate = format.readUInt32LE(4);
  const alignment = format.readUInt16LE(12),
    bits = format.readUInt16LE(14);
  if (codec === 0xfffe) {
    if (
      format.length !== 40 ||
      format.readUInt16LE(16) !== 22 ||
      format.readUInt16LE(18) < 1 ||
      format.readUInt16LE(18) > bits ||
      !format
        .subarray(28, 40)
        .equals(Buffer.from("00001000800000aa00389b71", "hex"))
    )
      invalid();
    codec = format.readUInt32LE(24);
  } else if (
    format.length !== 16 &&
    (format.length !== 18 || format.readUInt16LE(16) !== 0)
  )
    invalid();
  if (
    (codec !== 1 && codec !== 3) ||
    (codec === 1 && ![8, 16, 24, 32].includes(bits)) ||
    (codec === 3 && ![32, 64].includes(bits)) ||
    alignment !== (channels * bits) / 8 ||
    !alignment ||
    format.readUInt32LE(8) !== rate * alignment ||
    data.length % alignment
  )
    invalid();
  const samples = data.length / alignment;
  checkAudioParameters(rate, channels, samples);
  const mono = new Float32Array(samples);
  const width = bits / 8;
  let peak = 1;
  for (let frame = 0; frame < samples; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const position = frame * alignment + channel * width;
      let value: number;
      if (codec === 3)
        value =
          bits === 32
            ? data.readFloatLE(position)
            : data.readDoubleLE(position);
      else if (bits === 8) value = (data[position] - 128) / 128;
      else if (bits === 16) value = data.readInt16LE(position) / 32768;
      else if (bits === 24) value = data.readIntLE(position, 3) / 8388608;
      else value = data.readInt32LE(position) / 2147483648;
      if (!Number.isFinite(value) || Math.abs(value) > 1000000)
        throw new Error("Audio contains nonfinite or excessive PCM values.");
      peak = Math.max(peak, Math.abs(value));
      sum += value;
    }
    mono[frame] = sum / channels;
  }
  const warnings = [
    `Decoded WAV: ${rate} Hz, ${channels} channel${channels === 1 ? "" : "s"}, ${codec === 1 ? "integer" : "float"} PCM ${bits}-bit.`,
  ];
  if (channels === 2)
    warnings.push(
      "Stereo channels are averaged to mono for recognition; opposite-phase content may cancel. No speaker identities are inferred.",
    );
  if (peak > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] /= peak;
    warnings.push(
      "Floating-point PCM exceeded unit amplitude and was scaled by its peak before recognition.",
    );
  }
  return { mono, sampleRate: rate, channels, warnings };
}

export function resampleAudio(
  mono: Float32Array,
  inputRate: number,
): Float32Array {
  checkAudioParameters(inputRate, 1, mono.length);
  for (const sample of mono)
    if (!Number.isFinite(sample))
      throw new Error("Audio contains nonfinite samples.");
  if (inputRate === AUDIO_TARGET_RATE) return mono;
  const count = Math.floor((mono.length * AUDIO_TARGET_RATE) / inputRate);
  checkAudioParameters(AUDIO_TARGET_RATE, 1, count);
  // Hann-windowed sinc, with cutoff and support scaled for anti-aliasing.
  // Quantized sub-sample phases bound coefficient computation; zero padding
  // defines the edge policy and does not append invented audio samples.
  const cutoff = Math.min(1, AUDIO_TARGET_RATE / inputRate) * 0.94;
  const radius = Math.ceil(16 / cutoff),
    taps = radius * 2;
  const phases = 256;
  const kernels = Array.from({ length: phases }, (_, phase) => {
    const kernel = new Float64Array(taps);
    let sum = 0;
    for (let tap = 0; tap < taps; tap++) {
      const x = tap - radius + 1 - phase / phases;
      const scaled = Math.PI * x * cutoff;
      const sinc = scaled === 0 ? cutoff : Math.sin(scaled) / (Math.PI * x);
      const coefficient =
        Math.abs(x) <= radius
          ? sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / radius))
          : 0;
      kernel[tap] = coefficient;
      sum += coefficient;
    }
    for (let tap = 0; tap < taps; tap++) kernel[tap] /= sum;
    return kernel;
  });
  const output = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const position = (i * inputRate) / AUDIO_TARGET_RATE;
    const base = Math.floor(position);
    const kernel = kernels[Math.floor((position - base) * phases)];
    let sample = 0;
    const start = base - radius + 1;
    for (
      let tap = Math.max(0, -start);
      tap < taps && start + tap < mono.length;
      tap++
    )
      sample += mono[start + tap] * kernel[tap];
    output[i] = sample;
  }
  return output;
}
