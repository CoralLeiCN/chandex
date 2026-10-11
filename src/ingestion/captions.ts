import type { Extracted } from "./extract.ts";

export const MAX_CUES = 20000;
export const MAX_TIMELINE_MS = 24 * 60 * 60 * 1000;
const warning =
  "Caption times and speaker labels are supplied metadata, not verified alignment or identity. Check names, numbers and wording against the original recording; visual evidence is not included.";
export function captionTime(input: string, kind: "srt" | "vtt") {
  const match = (
    kind === "srt"
      ? /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/
      : /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/
  ).exec(input);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59)
    throw Error("Invalid caption timestamp.");
  const value =
    ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) *
      1000 +
    Number(match[4]);
  if (!Number.isSafeInteger(value) || value > MAX_TIMELINE_MS)
    throw Error("Caption timeline exceeds 24 hours.");
  return value;
}
export function timeLabel(value: number) {
  const seconds = Math.floor(value / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(value % 1000).padStart(3, "0")}`;
}
function decodeEntities(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    nbsp: "\u00a0",
    lrm: "\u200e",
    rlm: "\u200f",
    quot: '"',
    apos: "'",
  };
  return text.replace(
    /&(#\d{1,7}|#x[\da-fA-F]{1,6}|amp|lt|gt|nbsp|lrm|rlm|quot|apos);/g,
    (_, token: string) => {
      if (!token.startsWith("#")) return named[token];
      const value = parseInt(
        token.slice(token.startsWith("#x") ? 2 : 1),
        token.startsWith("#x") ? 16 : 10,
      );
      if (!value || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))
        throw Error("Invalid caption character reference.");
      return String.fromCodePoint(value);
    },
  );
}
function cueText(
  input: string,
  kind: "srt" | "vtt",
  warnings: Set<string>,
  start: number,
  end: number,
) {
  if (input.length > 32000) throw Error("Caption cue text is too long.");
  let previousInline = start;
  const text = input.replace(/<[^>\n]*>/g, (tag) => {
    if (/^<\/?(?:b|i|u)>$/.test(tag)) return "";
    if (kind === "vtt") {
      if (
        /^<\/?(?:ruby|rt|c)>$/.test(tag) ||
        /^<c(?:\.[\w-]+)+>$/.test(tag) ||
        /^<\/(?:v|lang)>$/.test(tag)
      )
        return "";
      const label = /^<(v|lang)\s+([^<>]+)>$/.exec(tag);
      if (label) {
        if (label[2].length > 120 || /[\x00-\x1f]/.test(label[2]))
          throw Error("Invalid caption cue label.");
        return `[${label[1] === "v" ? "Speaker" : "Language"} label: ${label[2].trim()}] `;
      }
      if (
        /^<\d{2,}:\d{2}:\d{2}\.\d{3}>$/.test(tag) ||
        /^<\d{2}:\d{2}\.\d{3}>$/.test(tag)
      ) {
        const time = captionTime(tag.slice(1, -1), "vtt");
        if (time < previousInline || time > end)
          throw Error(
            "Inline caption timestamps must stay ordered within the cue.",
          );
        previousInline = time;
        warnings.add(
          "Inline karaoke timestamps are omitted; declared cue start/end times are retained.",
        );
        return "";
      }
    }
    throw Error(
      "Unsupported caption cue markup. Use plain text or supported caption formatting.",
    );
  });
  // Decode escaped markup once after stripping supported literal tags. It remains plain source text.
  if (/<[^>]*$/.test(text)) throw Error("Malformed caption cue markup.");
  return decodeEntities(text).normalize("NFC").trim();
}
export function extractCaptions(bytes: Buffer, kind: "srt" | "vtt"): Extracted {
  let input: string;
  try {
    input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Error("Caption files must use valid UTF-8.");
  }
  input = input.replace(/\r\n?/g, "\n");
  if (input.includes("\0"))
    throw Error("Caption files cannot contain binary content.");
  let lineCount = 1;
  for (const char of input)
    if (char === "\n" && ++lineCount > 100000)
      throw Error("Caption file has too many lines.");
  const blocks = input.trim().split(/\n[\t ]*\n+/),
    warnings = new Set([warning]);
  if (kind === "vtt") {
    const header = blocks.shift() ?? "";
    if (
      !/^WEBVTT(?:[\t ]+[^\n]*)?(?:\n[^\n]*)*$/.test(header) ||
      header.includes("-->")
    )
      throw Error("WebVTT requires a valid WEBVTT header and blank separator.");
  }
  const sections: Extracted["sections"] = [];
  let previousStart = -1,
    previousEnd = -1,
    total = 0;
  for (const block of blocks) {
    if (
      kind === "vtt" &&
      /^(NOTE(?:[\t ]|\n|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block)
    ) {
      warnings.add(
        "WebVTT notes, styles, regions and visual positioning are omitted from the text snapshot.",
      );
      continue;
    }
    const lines = block.split("\n");
    let timing = lines.shift() ?? "";
    if (kind === "srt") {
      if (!/^\d{1,10}$/.test(timing))
        throw Error("SRT cues require a numeric identifier.");
      timing = lines.shift() ?? "";
    } else if (!timing.includes("-->")) {
      if (!timing.trim() || timing.length > 200)
        throw Error("Invalid WebVTT cue identifier.");
      timing = lines.shift() ?? "";
    }
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/.exec(timing);
    if (!match) throw Error("Invalid caption cue timing.");
    const start = captionTime(match[1], kind),
      end = captionTime(match[2], kind);
    if (end <= start || start < previousStart)
      throw Error("Caption cue times must be ordered with positive duration.");
    if (match[3]) {
      if (
        kind === "srt" ||
        match[3]
          .split(/\s+/)
          .some(
            (s) =>
              !/^(?:vertical:(?:rl|lr)|line:(?:-?\d+|\d+(?:\.\d+)?%)(?:,(?:start|center|end))?|position:\d+(?:\.\d+)?%(?:,(?:line-left|center|line-right|auto))?|size:\d+(?:\.\d+)?%|align:(?:start|center|end|left|right)|region:[\w-]+)$/.test(
                s,
              ),
          )
      )
        throw Error("Unsupported caption positioning settings.");
      warnings.add(
        "WebVTT notes, styles, regions and visual positioning are omitted from the text snapshot.",
      );
    }
    if (start < previousEnd)
      warnings.add(
        "Overlapping cues and repeated wording are retained; they do not prove distinct speakers or repeated events.",
      );
    const text = cueText(lines.join("\n"), kind, warnings, start, end);
    if (!text.trim()) throw Error("Caption cue contains no usable text.");
    total += Array.from(text).length;
    if (total > 500000 || sections.length >= MAX_CUES)
      throw Error("Caption transcript exceeds its cue/text budget.");
    sections.push({
      locator: `Cue ${sections.length + 1} · ${timeLabel(start)}–${timeLabel(end)}`,
      text,
    });
    previousStart = start;
    previousEnd = end;
  }
  if (!sections.length) throw Error("No usable caption cues found.");
  return { sections, warnings: [...warnings] };
}
