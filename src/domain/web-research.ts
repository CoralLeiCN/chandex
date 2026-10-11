import { isIP } from "node:net";
import { publicAddress } from "../ingestion/url.ts";

export interface WebCandidate {
  title: string;
  url: string;
}
export const webCandidateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          url: { type: "string", minLength: 1, maxLength: 4000 },
        },
      },
    },
  },
};
export function webQuery(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw Error(
      "Enter a search query of at most 1,000 characters on one line.",
    );
  return value.trim();
}
// Syntactic discovery policy. The importer additionally resolves and pins DNS,
// rejects non-public addresses and rechecks every redirect before fetching.
export function candidateURL(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 4000 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  )
    throw Error("Invalid candidate URL.");
  const u = new URL(value),
    host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port)) ||
    (isIP(host)
      ? !publicAddress(host)
      : !host.includes(".") ||
        /(^|\.)(localhost|local|localdomain|internal|test|invalid|example|home\.arpa)$/i.test(
          host,
        ))
  )
    throw Error("Candidate must be a public HTTP(S) page without credentials.");
  u.hash = "";
  return u.href;
}
export function validateCandidates(value: unknown): WebCandidate[] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "candidates"
  )
    throw Error("Invalid search response.");
  const candidates = (value as any).candidates;
  if (!Array.isArray(candidates) || candidates.length > 5)
    throw Error("Invalid search response.");
  const seen = new Set<string>();
  return candidates.map((c) => {
    if (
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      Object.keys(c).sort().join() !== "title,url" ||
      typeof c.title !== "string" ||
      !c.title.trim() ||
      c.title.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(c.title)
    )
      throw Error("Invalid candidate title.");
    const url = candidateURL(c.url);
    if (seen.has(url)) throw Error("Search returned duplicate pages.");
    seen.add(url);
    return { title: c.title.trim(), url };
  });
}
