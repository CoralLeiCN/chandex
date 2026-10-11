import { audioFormat, preflightAudio } from "./audio-containers.ts";
import { createAacDecoder } from "./audio-aac.ts";
import { parseM4a } from "./audio-m4a.ts";
import { decodeWav, type DecodedAudio } from "./audio-pcm.ts";
import { checkAudioParameters } from "./audio-limits.ts";
import { MAX_BYTES } from "./url.ts";

interface CodecResult {
  channelData: Float32Array[];
  sampleRate: number;
  samplesDecoded?: number;
  errors?: unknown[] | number;
}
const failure = () =>
  new Error(
    "Audio decoding failed, changed parameters or returned incomplete samples. Nothing was imported.",
  );

function accumulator(
  sampleRate: number,
  channels: number,
  samples: number,
  monoDuplicate = false,
) {
  checkAudioParameters(sampleRate, channels, samples);
  const mono = new Float32Array(samples);
  let offset = 0,
    peak = 1;
  return {
    add(result: CodecResult) {
      if (
        result.errors !== undefined &&
        (Array.isArray(result.errors)
          ? result.errors.length
          : result.errors) !== 0
      )
        throw failure();
      const length = result.channelData[0]?.length ?? 0;
      if (!length) return;
      if (
        result.sampleRate !== sampleRate ||
        offset + length > samples ||
        (result.samplesDecoded !== undefined &&
          result.samplesDecoded !== length) ||
        result.channelData.some(
          (channel) =>
            !(channel instanceof Float32Array) || channel.length !== length,
        )
      )
        throw failure();
      const duplicated =
        monoDuplicate && channels === 1 && result.channelData.length === 2;
      if (result.channelData.length !== channels && !duplicated)
        throw failure();
      for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let channel = 0; channel < result.channelData.length; channel++) {
          const value = result.channelData[channel][i];
          if (
            !Number.isFinite(value) ||
            Math.abs(value) > 1000000 ||
            (duplicated && channel === 1 && value !== result.channelData[0][i])
          )
            throw failure();
          peak = Math.max(peak, Math.abs(value));
          sum += value;
        }
        mono[offset + i] = sum / result.channelData.length;
      }
      offset += length;
    },
    finish(warnings: string[]): DecodedAudio {
      if (offset !== samples) throw failure();
      if (channels === 2)
        warnings.push(
          "Stereo channels are averaged to mono for recognition; opposite-phase content may cancel. No speaker identities are inferred.",
        );
      if (peak > 1) {
        for (let i = 0; i < mono.length; i++) mono[i] /= peak;
        warnings.push(
          "Decoded PCM exceeded unit amplitude and was scaled by its peak before recognition.",
        );
      }
      return { mono, sampleRate, channels, warnings };
    },
  };
}

async function decodeAac(bytes: Buffer, m4a: boolean): Promise<DecodedAudio> {
  const plan = m4a ? parseM4a(bytes) : undefined;
  const layout = plan ? undefined : preflightAudio(bytes, "aac");
  const packets: Buffer[] = [];
  if (plan) packets.push(...plan.packets);
  else
    for (let offset = 0; offset < bytes.length;) {
      const length =
        ((bytes[offset + 3] & 3) << 11) |
        (bytes[offset + 4] << 3) |
        (bytes[offset + 5] >> 5);
      packets.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
  const sourceRate = plan?.sampleRate ?? layout!.sampleRate,
    channels = plan?.channels ?? layout!.channels;
  const decoder = await createAacDecoder(
    plan ? { asc: plan.asc } : { firstAdts: packets[0] },
  );
  try {
    const rate = decoder.initialRate,
      factor = rate / sourceRate;
    if ((factor !== 1 && factor !== 2) || decoder.initialChannels !== channels)
      throw failure();
    const rawSamples = (packets.length - 1) * 1024 * factor;
    checkAudioParameters(rate, channels, rawSamples);
    // FAAD2 exposes its real startup error separately from its withheld first
    // frame. A doubled implicit-SBR output has a 962-sample QMF delay.
    const skip = plan?.window
      ? Math.max(
          0,
          plan.window.start * factor -
            (1024 * factor - (factor === 2 ? 962 : 0)),
        )
      : 0;
    const samples = plan?.window ? plan.window.samples * factor : rawSamples;
    if (skip + samples > rawSamples) throw failure();
    const output = accumulator(rate, channels, samples);
    let rawOffset = 0;
    for (const [index, packet] of packets.entries()) {
      const decoded = decoder.decode(packet);
      if (
        decoded.sampleRate !== rate ||
        decoded.channelData.length !== channels ||
        decoded.samplesDecoded !== (index ? 1024 * factor : 0)
      )
        throw failure();
      const length = decoded.samplesDecoded;
      const start = Math.max(0, skip - rawOffset),
        end = Math.min(length, skip + samples - rawOffset);
      if (end > start)
        output.add({
          ...decoded,
          channelData: decoded.channelData.map((channel) =>
            channel.subarray(start, end),
          ),
          samplesDecoded: end - start,
        });
      rawOffset += length;
    }
    if (rawOffset !== rawSamples) throw failure();
    const warnings = [
      `Decoded ${m4a ? "M4A AAC-LC" : "ADTS AAC-LC"}: ${sourceRate} Hz declared, ${rate} Hz decoded, ${channels} channel${channels === 1 ? "" : "s"}; FAAD2 WASM from @audio/decode-aac 1.6.0.`,
      plan?.window
        ? "The single M4A presentation edit trims declared encoder priming/padding; transcript times are relative to that decoded presentation."
        : "The AAC decoder withholds its first priming frame. No complete gapless presentation window was supplied; transcript times are relative to the available decoded audio and encoder padding may remain.",
    ];
    if (factor === 2)
      warnings.push(
        "The AAC decoder uses implicit SBR upsampling; its output rate differs from the container rate and timing includes decoder/filter uncertainty.",
      );
    return output.finish(warnings);
  } finally {
    decoder.free();
  }
}

export async function decodeAudio(bytes: Buffer): Promise<DecodedAudio> {
  if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 25 MiB.");
  const format = audioFormat(bytes);
  if (!format)
    throw new Error(
      "Unsupported audio recording. Use WAV, MP3, AAC-LC M4A/ADTS, FLAC, or a single Ogg Vorbis/Opus stream.",
    );
  if (format === "wav") return decodeWav(bytes);
  if (format === "aac" || format === "m4a")
    return decodeAac(bytes, format === "m4a");
  const layout = preflightAudio(bytes, format),
    samples = layout.expectedSamples ?? layout.samples;
  const output = accumulator(
    layout.sampleRate,
    layout.channels,
    samples,
    format === "mp3",
  );
  const { decoder: create } =
    format === "mp3"
      ? await import("@audio/decode-mp3")
      : format === "flac"
        ? await import("@audio/decode-flac")
        : format === "opus"
          ? await import("@audio/decode-opus")
          : await import("@audio/decode-vorbis");
  const decoder = await create();
  try {
    for (let offset = 0; offset < bytes.length; offset += 16384)
      output.add(decoder.decode(bytes.subarray(offset, offset + 16384)));
    if ("flush" in decoder && typeof decoder.flush === "function")
      output.add(decoder.flush());
    return output.finish([
      `Decoded ${format.toUpperCase()}: ${layout.sampleRate} Hz, ${layout.channels} channel${layout.channels === 1 ? "" : "s"}; local @audio/decode-${format} codec.`,
      format === "mp3"
        ? "MP3 uses its declared Xing/LAME gapless sample count where available. Mono decoder output is accepted only when both emitted channels agree at every sample; untagged recordings may retain encoder padding."
        : "The complete decoded sample count agrees with the container's declared audio timeline.",
    ]);
  } catch {
    throw failure();
  } finally {
    decoder.free();
  }
}
