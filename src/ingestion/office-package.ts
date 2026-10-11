import { fromBufferPromise } from "yauzl";
import { SaxesParser } from "saxes";
import { crc32 } from "node:zlib";
import path from "node:path";

export class FormatError extends Error {}
export interface XmlNode {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}
export const namespaces = {
  w: [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
  ],
  p: [
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
  ],
  a: [
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
  ],
  x: [
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
  ],
  r: [
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
  ],
  pkg: ["http://schemas.openxmlformats.org/package/2006/relationships"],
  ct: ["http://schemas.openxmlformats.org/package/2006/content-types"],
} as const;
export type Family = keyof typeof namespaces;
export const is = (node: XmlNode, family: Family, name: string) =>
  node.name === name &&
  (namespaces[family] as readonly string[]).includes(node.uri);
export const children = (node: XmlNode): XmlNode[] =>
  node.children.filter((child): child is XmlNode => typeof child !== "string");
export function descendants(
  node: XmlNode,
  family: Family,
  name: string,
): XmlNode[] {
  return children(node).flatMap((child) => [
    ...(is(child, family, name) ? [child] : []),
    ...descendants(child, family, name),
  ]);
}
export const attr = (node: XmlNode, name: string, family?: Family) =>
  family
    ? namespaces[family]
        .map((uri) => node.attrs[`{${uri}}${name}`])
        .find((value) => value !== undefined)
    : node.attrs[`{}${name}`];
export function text(node: XmlNode): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
}
export const normalize = (value: string) =>
  value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
export const short = (value: string) =>
  Array.from(value).slice(0, 160).join("");

export function decodeXml(bytes: Buffer) {
  try {
    const encoding =
      (bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0x3c && bytes[1] === 0)
        ? "utf-16le"
        : (bytes[0] === 0xfe && bytes[1] === 0xff) ||
            (bytes[0] === 0 && bytes[1] === 0x3c)
          ? "utf-16be"
          : "utf-8";
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new FormatError("Office XML contains invalid text encoding.");
  }
}
export async function officePackage(bytes: Buffer) {
  const parts = new Map<string, Buffer>(),
    names = new Set<string>();
  let decoded = 0,
    entries = 0,
    elements = 0;
  const warnings = new Set<string>();
  try {
    const zip = await fromBufferPromise(bytes, {
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    try {
      for await (const entry of zip.eachEntry()) {
        if (++entries > 10000)
          throw new FormatError("Office package exceeds 10,000 entries.");
        const name = entry.fileName,
          canonical = name.replace(/\/$/, "");
        if (
          !canonical ||
          canonical !== path.posix.normalize(canonical) ||
          /[\0-\x1f]/.test(name) ||
          names.has(name)
        )
          throw new FormatError(
            "Office package contains duplicate or unsafe member paths.",
          );
        names.add(name);
        if (entry.isEncrypted())
          throw new FormatError("Encrypted Office packages are not supported.");
        if (/vbaProject\.bin$/i.test(name))
          throw new FormatError(
            "Macro-enabled Office files are not supported.",
          );
        if (!/\.(xml|rels)$/i.test(name)) continue;
        if (!entry.canDecodeFileData())
          throw new FormatError("Office package uses unsupported compression.");
        if (
          entry.uncompressedSize > 8 * 1024 * 1024 ||
          decoded + entry.uncompressedSize > 64 * 1024 * 1024
        )
          throw new FormatError("Office XML exceeds the decoded size budget.");
        const stream = await zip.openReadStreamPromise(entry),
          chunks: Buffer[] = [];
        let size = 0,
          checksum = 0;
        for await (const value of stream) {
          const chunk = Buffer.from(value);
          size += chunk.length;
          if (size > 8 * 1024 * 1024 || decoded + size > 64 * 1024 * 1024) {
            stream.destroy();
            throw new FormatError(
              "Office XML exceeds the decoded size budget.",
            );
          }
          checksum = crc32(chunk, checksum);
          chunks.push(chunk);
        }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32)
          throw new FormatError(
            "Office package failed size or CRC validation.",
          );
        decoded += size;
        parts.set(name, Buffer.concat(chunks));
      }
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError(
      "Office package is malformed, encrypted or not a supported ZIP document.",
    );
  }
  const parsed = new Map<string, XmlNode>();
  const xml = (name: string): XmlNode => {
    const cached = parsed.get(name);
    if (cached) return cached;
    const bytes = parts.get(name);
    if (!bytes)
      throw new FormatError(
        "Office package is missing a required content part.",
      );
    let root: XmlNode | undefined;
    const stack: XmlNode[] = [];
    try {
      const parser = new SaxesParser({ xmlns: true });
      parser.on("doctype", () => {
        throw new FormatError(
          "Office XML declarations and external entities are not supported.",
        );
      });
      parser.on("error", () => {
        throw new FormatError(
          "Office XML is malformed or uses unsupported entities.",
        );
      });
      parser.on("opentag", (tag) => {
        if (
          ++elements > 100000 ||
          stack.length >= 64 ||
          Object.keys(tag.attributes).length > 32
        )
          throw new FormatError(
            "Office XML exceeds element, attribute or depth limits.",
          );
        const node: XmlNode = {
          name: tag.local,
          uri: tag.uri,
          attrs: Object.fromEntries(
            Object.values(tag.attributes).map((a) => [
              `{${a.uri}}${a.local}`,
              a.value,
            ]),
          ),
          children: [],
        };
        if (stack.length) stack.at(-1)!.children.push(node);
        else root = node;
        stack.push(node);
      });
      const addText = (value: string) => {
        if (stack.length) stack.at(-1)!.children.push(value);
      };
      parser.on("text", addText);
      parser.on("cdata", addText);
      parser.on("closetag", () => {
        const node = stack.pop()!;
        if (
          node.uri ===
            "http://schemas.openxmlformats.org/markup-compatibility/2006" &&
          node.name === "AlternateContent"
        ) {
          const options = children(node),
            chosen =
              options.find((n) => n.name === "Fallback") ??
              options.find((n) => n.name === "Choice");
          node.children = chosen?.children ?? [];
          warnings.add(
            "Alternate representations use fallback text; visual alternatives are not interpreted.",
          );
        }
      });
      parser.write(decodeXml(bytes)).close();
    } catch (error) {
      if (error instanceof FormatError) throw error;
      throw new FormatError("Office XML could not be parsed safely.");
    }
    if (!root) throw new FormatError("Office content part is empty.");
    parsed.set(name, root);
    return root;
  };
  const relationships = (part: string) => {
    const name = part
      ? path.posix.join(
          path.posix.dirname(part),
          "_rels",
          path.posix.basename(part) + ".rels",
        )
      : "_rels/.rels";
    const result = new Map<string, { type: string; target: string | null }>();
    if (!parts.has(name)) return result;
    const doc = xml(name);
    if (!is(doc, "pkg", "Relationships"))
      throw new FormatError("Office relationship namespace is invalid.");
    for (const entry of children(doc)) {
      if (!is(entry, "pkg", "Relationship")) continue;
      const id = attr(entry, "Id"),
        type = attr(entry, "Type"),
        target = attr(entry, "Target");
      if (!id || !type || !target || result.has(id))
        throw new FormatError(
          "Office relationships are missing fields or contain duplicate IDs.",
        );
      if (type.endsWith("/hyperlink")) {
        warnings.add(
          "Hyperlink display text is retained; hyperlink destinations are not followed.",
        );
        result.set(id, { type, target: null });
        continue;
      }
      if (
        attr(entry, "TargetMode") === "External" ||
        /^[a-z][a-z\d+.-]*:/i.test(target)
      ) {
        warnings.add(
          "External relationships are not fetched; linked documents, images and data may be absent.",
        );
        result.set(id, { type, target: null });
        continue;
      }
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(target);
      } catch {
        throw new FormatError("Office relationship target is invalid.");
      }
      if (/[\\\0-\x1f?#]/.test(decodedTarget))
        throw new FormatError("Office relationship target is unsafe.");
      const resolved = path.posix.normalize(
        decodedTarget.startsWith("/")
          ? decodedTarget.slice(1)
          : path.posix.join(path.posix.dirname(part), decodedTarget),
      );
      if (
        resolved === ".." ||
        resolved.startsWith("../") ||
        resolved.startsWith("/") ||
        /^[a-z][a-z\d+.-]*:/i.test(resolved)
      )
        throw new FormatError("Office relationship escapes the package.");
      result.set(id, { type, target: resolved });
    }
    return result;
  };
  const types = xml("[Content_Types].xml");
  if (!is(types, "ct", "Types"))
    throw new FormatError("Office content types are invalid.");
  const contentTypes = new Map<string, string>();
  for (const node of children(types)) {
    const type = attr(node, "ContentType") ?? "";
    if (/macroEnabled|vbaProject/i.test(type))
      throw new FormatError("Macro-enabled Office files are not supported.");
    if (is(node, "ct", "Override")) {
      const part = (attr(node, "PartName") ?? "").replace(/^\//, "");
      if (!part || !type || contentTypes.has(part))
        throw new FormatError(
          "Office content types have missing fields or duplicate parts.",
        );
      contentTypes.set(part, type);
    }
  }
  // Inspect relationship metadata without opening any external destination.
  for (const name of parts.keys())
    if (name.endsWith(".rels")) {
      const part =
        name === "_rels/.rels"
          ? ""
          : path.posix.join(
              path.posix.dirname(path.posix.dirname(name)),
              path.posix.basename(name).slice(0, -5),
            );
      relationships(part);
    }
  const mains = [...relationships("").values()].filter((r) =>
    r.type.endsWith("/officeDocument"),
  );
  if (mains.length !== 1 || !mains[0].target)
    throw new FormatError(
      "Office package requires one internal document root.",
    );
  return {
    xml,
    parts,
    names,
    warnings,
    relationships,
    contentTypes,
    main: mains[0].target,
  };
}
export type OfficePackage = Awaited<ReturnType<typeof officePackage>>;
