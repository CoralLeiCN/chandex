import type { Citation } from "../../src/domain/evidence.ts";
import type { RichNote } from "../../src/domain/notes.ts";
export function richFixture(citation?: Citation): RichNote {
  return {
    format: "rich-note",
    version: 1,
    doc: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Research 🦉" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Conditional budget",
              marks: [{ type: "bold" }, { type: "italic" }],
            },
            { type: "hardBreak" },
            {
              type: "text",
              text: "<img src=x onerror=alert(1)> *literal*",
              marks: [{ type: "underline" }, { type: "strike" }],
            },
            {
              type: "text",
              text: " official page",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.org/review?q=(pilot)" },
                },
              ],
            },
            ...(citation ? [{ type: "citation", attrs: { citation } }] : []),
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Review qualifiers" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "Check approval" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Approval remains pending." }],
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "`sample`", marks: [{ type: "code" }] },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "```\n<script>literal()</script>" }],
        },
        { type: "horizontalRule" },
      ],
    },
  };
}
