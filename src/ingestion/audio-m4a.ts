import { checkAudioParameters } from "./audio-limits.ts";
import { MAX_BYTES } from "./url.ts";

export interface M4aAudio {
  asc: Buffer;
  sampleRate: number;
  channels: number;
  packets: Buffer[];
  window?: { start: number; samples: number };
}
interface Box {
  type: string;
  body: number;
  end: number;
}
function invalid(): never {
  throw new Error(
    "Malformed, truncated or unsupported M4A recording. Use unencrypted, nonfragmented AAC-LC audio with one track and a simple presentation timeline.",
  );
}

export function parseM4a(bytes: Buffer): M4aAudio {
  if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 25 MiB.");
  let visited = 0;
  const boxes = (start: number, end: number): Box[] => {
    const result: Box[] = [];
    while (start < end) {
      if (++visited > 10000 || start + 8 > end) invalid();
      let size = bytes.readUInt32BE(start),
        header = 8;
      const type = bytes.toString("ascii", start + 4, start + 8);
      if (size === 1) {
        if (start + 16 > end) invalid();
        const large = bytes.readBigUInt64BE(start + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
        size = Number(large);
        header = 16;
      } else if (size === 0) {
        if (type !== "mdat") invalid();
        size = end - start;
      }
      if (
        size < header ||
        start + size > end ||
        ["moof", "mfra", "pssh", "senc", "saio", "saiz"].includes(type)
      )
        invalid();
      result.push({ type, body: start + header, end: start + size });
      start += size;
    }
    return result;
  };
  const children = (box: Box) => boxes(box.body, box.end);
  const one = (
    list: Box[],
    type: string,
    optional = false,
  ): Box | undefined => {
    const found = list.filter((box) => box.type === type);
    if (found.length > 1 || (!optional && found.length !== 1)) invalid();
    return found[0];
  };
  const body = (box: Box) => bytes.subarray(box.body, box.end);
  const full = (box: Box, min: number) => {
    const value = body(box);
    if (value.length < min || value.readUInt32BE(0) !== 0) invalid();
    return value;
  };
  const clock = (box: Box) => {
    const value = body(box),
      version = value[0];
    if (
      ![0, 1].includes(version) ||
      value.length < (version ? 36 : 24) ||
      value.readUIntBE(1, 3)
    )
      invalid();
    const timescale = value.readUInt32BE(version ? 20 : 12);
    const duration = version
      ? Number(value.readBigUInt64BE(24))
      : value.readUInt32BE(16);
    if (!timescale || timescale > 1000000 || !Number.isSafeInteger(duration))
      invalid();
    return { timescale, duration };
  };
  const top = boxes(0, bytes.length);
  const ftyp = one(top, "ftyp")!,
    moov = one(top, "moov")!;
  if (ftyp.body !== 8 || ftyp.end - ftyp.body < 8 || (ftyp.end - ftyp.body) % 4)
    invalid();
  const mdats = top.filter((box) => box.type === "mdat");
  if (!mdats.length) invalid();
  const movie = children(moov),
    movieClock = clock(one(movie, "mvhd")!);
  const tracks = movie.filter((box) => box.type === "trak");
  if (tracks.length !== 1 || one(movie, "mvex", true)) invalid();
  const track = children(tracks[0]),
    media = children(one(track, "mdia")!);
  const handler = body(one(media, "hdlr")!);
  if (handler.length < 12 || handler.toString("ascii", 8, 12) !== "soun")
    invalid();
  const mediaClock = clock(one(media, "mdhd")!);
  const info = children(one(media, "minf")!);
  const dinf = children(one(info, "dinf")!);
  const dref = one(dinf, "dref")!,
    references = full(dref, 8);
  const referenceEntries = boxes(dref.body + 8, dref.end);
  if (
    references.readUInt32BE(4) !== 1 ||
    referenceEntries.length !== 1 ||
    referenceEntries[0].type !== "url " ||
    referenceEntries[0].end - referenceEntries[0].body !== 4 ||
    bytes.readUInt32BE(referenceEntries[0].body) !== 1
  )
    invalid();
  const table = children(one(info, "stbl")!);
  if (table.some((box) => ["ctts", "stz2"].includes(box.type))) invalid();
  const stsd = one(table, "stsd")!,
    descriptions = full(stsd, 8);
  const entries = boxes(stsd.body + 8, stsd.end);
  if (
    descriptions.readUInt32BE(4) !== 1 ||
    entries.length !== 1 ||
    entries[0].type !== "mp4a"
  )
    invalid();
  const sample = entries[0],
    description = body(sample);
  if (
    description.length < 28 ||
    description.readUInt16BE(6) !== 1 ||
    description.readUInt16BE(8) !== 0
  )
    invalid();
  const channels = description.readUInt16BE(16),
    sampleRate = description.readUInt32BE(24) / 65536;
  checkAudioParameters(sampleRate, channels, 1);
  const sampleChildren = boxes(sample.body + 28, sample.end);
  if (sampleChildren.some((box) => ["sinf", "wave"].includes(box.type)))
    invalid();
  const esds = full(one(sampleChildren, "esds")!, 5);
  let descriptors = 0;
  const tags = (
    start: number,
    end: number,
  ): { tag: number; start: number; end: number }[] => {
    const result: { tag: number; start: number; end: number }[] = [];
    while (start < end) {
      if (++descriptors > 100 || start + 2 > end) invalid();
      const tag = esds[start++];
      let length = 0,
        done = false;
      for (let i = 0; i < 4; i++) {
        if (start >= end) invalid();
        const octet = esds[start++];
        length = length * 128 + (octet & 127);
        if (!(octet & 128)) {
          done = true;
          break;
        }
      }
      if (!done || start + length > end) invalid();
      result.push({ tag, start, end: start + length });
      start += length;
    }
    return result;
  };
  const uniqueTag = (list: ReturnType<typeof tags>, tag: number) => {
    const found = list.filter((value) => value.tag === tag);
    if (found.length !== 1) invalid();
    return found[0];
  };
  const es = uniqueTag(tags(4, esds.length), 3);
  if (es.end - es.start < 3 || esds[es.start + 2] & 0xe0) invalid();
  const decoder = uniqueTag(tags(es.start + 3, es.end), 4);
  if (
    decoder.end - decoder.start < 13 ||
    esds[decoder.start] !== 0x40 ||
    ((esds[decoder.start + 1] >> 2) & 63) !== 5
  )
    invalid();
  const specific = uniqueTag(tags(decoder.start + 13, decoder.end), 5);
  const asc = esds.subarray(specific.start, specific.end);
  // AAC-LC, 1024-sample frames, one/two declared channels. Recognize the
  // common explicit "no SBR" extension without overriding a real HE profile.
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ];
  if (
    (asc.length !== 2 &&
      (asc.length !== 5 ||
        !asc.subarray(2).equals(Buffer.from([0x56, 0xe5, 0])))) ||
    asc[0] >> 3 !== 2 ||
    (asc[1] & 7) !== 0 ||
    rates[((asc[0] & 7) << 1) | (asc[1] >> 7)] !== sampleRate ||
    ((asc[1] >> 3) & 15) !== channels
  )
    invalid();
  const sizesData = full(one(table, "stsz")!, 12),
    fixedSize = sizesData.readUInt32BE(4),
    sampleCount = sizesData.readUInt32BE(8);
  if (
    !sampleCount ||
    sampleCount > 60000 ||
    sizesData.length !== (fixedSize ? 12 : 12 + sampleCount * 4)
  )
    invalid();
  const sizes = Array.from(
    { length: sampleCount },
    (_, i) => fixedSize || sizesData.readUInt32BE(12 + i * 4),
  );
  if (sizes.some((size) => !size || size > 65536)) invalid();
  checkAudioParameters(sampleRate, channels, sampleCount * 1024);
  const stts = full(one(table, "stts")!, 8),
    timeCount = stts.readUInt32BE(4);
  if (
    !timeCount ||
    timeCount > sampleCount ||
    stts.length !== 8 + timeCount * 8
  )
    invalid();
  let timedSamples = 0,
    ticks = 0;
  for (let i = 0; i < timeCount; i++) {
    const count = stts.readUInt32BE(8 + i * 8),
      delta = stts.readUInt32BE(12 + i * 8);
    if (
      !count ||
      !delta ||
      delta / mediaClock.timescale >
        1024 / sampleRate + 1 / mediaClock.timescale
    )
      invalid();
    timedSamples += count;
    ticks += count * delta;
  }
  if (timedSamples !== sampleCount || ticks !== mediaClock.duration) invalid();
  const stco = one(table, "stco", true),
    co64 = one(table, "co64", true);
  if (Boolean(stco) === Boolean(co64)) invalid();
  const offsets = full((stco ?? co64)!, 8),
    width = stco ? 4 : 8,
    chunkCount = offsets.readUInt32BE(4);
  if (
    !chunkCount ||
    chunkCount > sampleCount ||
    offsets.length !== 8 + chunkCount * width
  )
    invalid();
  const stsc = full(one(table, "stsc")!, 8),
    mappingCount = stsc.readUInt32BE(4);
  if (
    !mappingCount ||
    mappingCount > chunkCount ||
    stsc.length !== 8 + mappingCount * 12
  )
    invalid();
  const mapping = Array.from({ length: mappingCount }, (_, i) => ({
    first: stsc.readUInt32BE(8 + i * 12),
    count: stsc.readUInt32BE(12 + i * 12),
    description: stsc.readUInt32BE(16 + i * 12),
  }));
  for (let i = 0; i < mapping.length; i++)
    if (
      (!i && mapping[i].first !== 1) ||
      (i && mapping[i].first <= mapping[i - 1].first) ||
      mapping[i].first > chunkCount ||
      !mapping[i].count ||
      mapping[i].count > sampleCount ||
      mapping[i].description !== 1
    )
      invalid();
  const packets: Buffer[] = [],
    ranges: { start: number; end: number }[] = [];
  let mapIndex = 0,
    sampleIndex = 0;
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    while (
      mapIndex + 1 < mapping.length &&
      mapping[mapIndex + 1].first <= chunk + 1
    )
      mapIndex++;
    const large = stco
      ? BigInt(offsets.readUInt32BE(8 + chunk * 4))
      : offsets.readBigUInt64BE(8 + chunk * 8);
    if (large > BigInt(bytes.length)) invalid();
    let offset = Number(large),
      start = offset;
    for (let i = 0; i < mapping[mapIndex].count; i++) {
      if (sampleIndex >= sampleCount) invalid();
      const size = sizes[sampleIndex++];
      if (!mdats.some((box) => offset >= box.body && offset + size <= box.end))
        invalid();
      packets.push(bytes.subarray(offset, offset + size));
      offset += size;
    }
    ranges.push({ start, end: offset });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].end) invalid();
  if (sampleIndex !== sampleCount) invalid();
  let window: M4aAudio["window"];
  const edts = one(track, "edts", true);
  if (edts) {
    const editBox = one(children(edts), "elst")!,
      edit = body(editBox),
      version = edit[0];
    if (
      ![0, 1].includes(version) ||
      edit.length !== (version ? 28 : 20) ||
      edit.readUIntBE(1, 3) ||
      edit.readUInt32BE(4) !== 1
    )
      invalid();
    const editDuration = version
      ? Number(edit.readBigUInt64BE(8))
      : edit.readUInt32BE(8);
    const mediaTime = version
      ? Number(edit.readBigInt64BE(16))
      : edit.readInt32BE(12);
    const rateOffset = version ? 24 : 16;
    if (
      !Number.isSafeInteger(editDuration) ||
      !Number.isSafeInteger(mediaTime) ||
      mediaTime < 0 ||
      mediaTime >= ticks ||
      edit.readInt16BE(rateOffset) !== 1 ||
      edit.readInt16BE(rateOffset + 2) !== 0
    )
      invalid();
    const start = Math.round((mediaTime * sampleRate) / mediaClock.timescale);
    const duration = Math.min(
      (ticks - mediaTime) / mediaClock.timescale,
      editDuration ? (editDuration + 1) / movieClock.timescale : Infinity,
    );
    window = { start, samples: Math.round(duration * sampleRate) };
    checkAudioParameters(sampleRate, channels, window.samples);
    if (
      Math.max(0, window.start - 1024) + window.samples >
      (sampleCount - 1) * 1024
    )
      invalid();
  }
  return { asc, sampleRate, channels, packets, window };
}
