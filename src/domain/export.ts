import type { Answer, Passage } from "./evidence.ts";
export function exportMarkdown(
  title: string,
  content: { text?: string } & Partial<Answer>,
  resolve: (id: string) => (Passage & { origin?: string | null }) | null,
): string {
  const lines = ["# " + title, ""];
  if (content.text) lines.push(content.text, "");
  let index = 0;
  const notes: string[] = [];
  for (const block of content.blocks ?? []) {
    const refs = block.citations.map((c) => {
      const label = ++index,
        p = resolve(c.passageId);
      notes.push(
        "[^" +
          label +
          "]: " +
          (p
            ? p.title +
              " — " +
              p.locator +
              "; revision " +
              p.revisionId +
              (p.origin
                ? " (" + p.origin + "). Evidence: "
                : " (local notebook source). Evidence: ") +
              c.quote
            : "Evidence unavailable."),
      );
      return "[^" + label + "]";
    });
    lines.push(block.text + refs.join(""), "");
  }
  if (content.coverageWarnings?.length)
    lines.push(
      "## Coverage",
      "",
      ...content.coverageWarnings.map((w) => "- " + w),
      "",
    );
  return [...lines, ...notes, ""].join("\n");
}
