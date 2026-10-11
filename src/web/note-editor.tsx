import React, { useEffect, useLayoutEffect, useState, useRef } from "react";
import { dictationContent } from "./voice-capture.ts";
import { cleanNoteDraft, type NoteDraftState } from "./note-dialog.tsx";
import { Node } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Plugin } from "@tiptap/pm/state";
import { api } from "./api.ts";
import {
  authoredReferenceNotice,
  editableNote,
  richNote,
  noteLink,
  type RichNote,
  type NoteNode,
} from "../domain/notes.ts";
import type { Passage } from "../domain/evidence.ts";

export function noteEditorDocument(value: unknown): RichNote {
  const initial = editableNote(value);
  const normalize = (node: NoteNode): NoteNode => ({
    ...node,
    ...(node.content
      ? {
          content: node.content.flatMap((child) =>
            child.type === "text"
              ? dictationContent(child.text!, node.type === "codeBlock").map(
                  (piece) => ({
                    ...piece,
                    ...(child.marks ? { marks: child.marks } : {}),
                  }),
                )
              : [normalize(child)],
          ),
        }
      : {}),
  });
  return richNote({ ...initial, doc: normalize(initial.doc) });
}

export function noteReferencePlugins() {
  return [
    new Plugin({
      appendTransaction(_transactions, _oldState, state) {
        const transaction = state.tr;
        state.doc.descendants((node, position) => {
          if (node.type.name === "citation" && node.marks.length)
            transaction.setNodeMarkup(position, undefined, node.attrs, []);
        });
        return transaction.docChanged ? transaction : null;
      },
    }),
  ];
}
const ReferenceNode = Node.create<{ availability: Record<string, boolean> }>({
  name: "citation",
  addOptions() {
    return { availability: {} };
  },
  group: "inline",
  inline: true,
  atom: true,
  marks: "",
  addProseMirrorPlugins() {
    return noteReferencePlugins();
  },
  addAttributes() {
    return { citation: { default: null, rendered: false } };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ node }) {
    const unavailable =
      this.options.availability[node.attrs.citation?.passageId] === false;
    return [
      "span",
      {
        "data-note-reference": "",
        class: "note-reference-atom",
        contenteditable: "false",
      },
      unavailable ? "↗ unavailable reference" : "↗ reference",
    ];
  },
  renderText() {
    return " [attached reference] ";
  },
});
const safeLink = (url: string) => {
  try {
    noteLink(url);
    return true;
  } catch {
    return false;
  }
};
export const noteEditorExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: {
      autolink: false,
      linkOnPaste: false,
      openOnClick: false,
      isAllowedUri: safeLink,
    },
  }),
  ReferenceNode,
];

export function RichNoteEditor({
  initial,
  initialTitle,
  sources,
  notebookId,
  onSave,
  onReload,
  onDraftState,
  availability = {},
}: {
  initial: any;
  initialTitle: string;
  sources: any[];
  notebookId: string;
  onSave: (title: string, document: RichNote) => Promise<void>;
  onReload?: () => Promise<void>;
  onDraftState?: (state: NoteDraftState) => void;
  availability?: Record<string, boolean>;
}) {
  const [title, setTitle] = useState(initialTitle),
    [documentChanged, setDocumentChanged] = useState(false),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [link, setLink] = useState(""),
    [showLink, setShowLink] = useState(false),
    [showReference, setShowReference] = useState(false),
    [source, setSource] = useState(""),
    [passages, setPassages] = useState<Passage[]>([]),
    [passage, setPassage] = useState(""),
    [quote, setQuote] = useState(""),
    [loading, setLoading] = useState(false);
  const [start] = useState(() => {
    try {
      return { document: noteEditorDocument(initial), error: "" };
    } catch (e) {
      return {
        document: editableNote({ text: "" }),
        error: (e as Error).message,
      };
    }
  });
  const editor = useEditor({
    extensions: noteEditorExtensions.map((extension) =>
      extension.name === "citation"
        ? ReferenceNode.configure({ availability })
        : extension,
    ),
    injectCSS: false,
    content: start.document.doc,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Note body",
        "aria-multiline": "true",
      },
      handleKeyDown(view, event) {
        if (event.key !== "Escape" || event.isComposing) return false;
        const dialog = view.dom.closest("dialog");
        if (!dialog) return false;
        // Route editor Escape through the dialog's guarded cancel path instead
        // of depending on contenteditable/browser default keyboard behavior.
        const Event = view.dom.ownerDocument.defaultView!.Event;
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
        event.preventDefault();
        return true;
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return false;
        event.preventDefault();
        const nodes = text
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .map((line) =>
            view.state.schema.nodes.paragraph.create(
              null,
              line ? view.state.schema.text(line) : undefined,
            ),
          );
        const { from, to } = view.state.selection;
        // Insert plain text through the editor schema, never clipboard HTML.
        editor?.commands.insertContentAt(
          { from, to },
          nodes.map((n) => n.toJSON()),
        );
        return true;
      },
      handleDrop(_view, event, _slice, moved) {
        if (!moved) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });
  const originalDocument = useRef<string | null>(null);
  if (editor && !originalDocument.current)
    originalDocument.current = JSON.stringify(
      editor.schema.nodeFromJSON(start.document.doc).toJSON(),
    );
  useEffect(() => {
    if (!editor) return;
    // Compare serialized content: equivalent browser editor node instances can
    // fail ProseMirror's identity-sensitive eq() after input and undo.
    const update = () =>
      setDocumentChanged(
        JSON.stringify(editor.getJSON()) !== originalDocument.current,
      );
    update();
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor]);
  const changed = title !== initialTitle || documentChanged;
  useLayoutEffect(() => {
    onDraftState?.({ changed, saving });
  }, [changed, saving, onDraftState]);
  useEffect(() => () => onDraftState?.(cleanNoteDraft), [onDraftState]);
  useEffect(() => {
    if (!changed && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed, saving]);
  useEffect(() => {
    editor?.setEditable(!saving);
  }, [editor, saving]);
  useEffect(() => {
    if (!source) {
      setPassages([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setPassages([]);
    setPassage("");
    setQuote("");
    void api(`/notebooks/${notebookId}/sources/${source}`)
      .then((data) => {
        if (alive)
          setPassages(
            data.passages.filter(
              (p: Passage) => p.revisionId === data.current_revision,
            ),
          );
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [source, notebookId]);
  if (!editor) return <p role="status">Opening editor…</p>;
  const button = (
    label: string,
    action: () => void,
    active?: boolean,
    disabled = false,
  ) => (
    <button
      type="button"
      className="small"
      aria-pressed={active}
      disabled={disabled || saving}
      key={label}
      onClick={action}
    >
      {label}
    </button>
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        try {
          if (start.error) throw new Error(start.error);
          const document = richNote({
            format: "rich-note",
            version: 1,
            doc: editor.getJSON(),
          });
          if (
            !editor.getText().trim() &&
            !document.doc.content?.some((n) => n.type === "horizontalRule")
          )
            throw new Error("Write a note before saving.");
          setSaving(true);
          void onSave(title, document)
            .catch((e) => setError(e.message))
            .finally(() => setSaving(false));
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      {(error || start.error) && (
        <p role="alert" className="error-bar">
          {error || start.error}
        </p>
      )}
      {changed && (
        <p role="status" className="fine">
          Unsaved changes
        </p>
      )}
      {error.includes("Note changed.") && onReload && (
        <button
          type="button"
          className="small"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onReload()
              .catch((e) => setError(e.message))
              .finally(() => setSaving(false));
          }}
        >
          Reload saved revision (discard this draft)
        </button>
      )}
      <label>
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
        />
      </label>
      <div
        className="rich-note-toolbar"
        role="group"
        aria-label="Note formatting"
      >
        {button(
          "Bold",
          () => {
            editor.chain().focus().toggleBold().run();
          },
          editor.isActive("bold"),
        )}
        {button(
          "Italic",
          () => {
            editor.chain().focus().toggleItalic().run();
          },
          editor.isActive("italic"),
        )}
        {button(
          "Underline",
          () => {
            editor.chain().focus().toggleUnderline().run();
          },
          editor.isActive("underline"),
        )}
        {button(
          "Strikethrough",
          () => {
            editor.chain().focus().toggleStrike().run();
          },
          editor.isActive("strike"),
        )}
        {button(
          "Inline code",
          () => {
            editor.chain().focus().toggleCode().run();
          },
          editor.isActive("code"),
        )}
        <label className="note-block-type">
          Block style
          <select
            aria-label="Block style"
            value={
              editor.isActive("heading")
                ? String(editor.getAttributes("heading").level)
                : "paragraph"
            }
            onChange={(e) => {
              const level = Number(e.target.value) as 1 | 2 | 3;
              if (level) editor.chain().focus().setHeading({ level }).run();
              else editor.chain().focus().setParagraph().run();
            }}
          >
            <option value="paragraph">Paragraph</option>
            <option value="1">Heading 1</option>
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
          </select>
        </label>
        {button(
          "Bullet list",
          () => {
            editor.chain().focus().toggleBulletList().run();
          },
          editor.isActive("bulletList"),
        )}
        {button(
          "Numbered list",
          () => {
            editor.chain().focus().toggleOrderedList().run();
          },
          editor.isActive("orderedList"),
        )}
        {button(
          "Indent",
          () => {
            editor.chain().focus().sinkListItem("listItem").run();
          },
          undefined,
          !editor.can().sinkListItem("listItem"),
        )}
        {button(
          "Outdent",
          () => {
            editor.chain().focus().liftListItem("listItem").run();
          },
          undefined,
          !editor.can().liftListItem("listItem"),
        )}
        {button(
          "Quote",
          () => {
            editor.chain().focus().toggleBlockquote().run();
          },
          editor.isActive("blockquote"),
        )}
        {button(
          "Code block",
          () => {
            editor.chain().focus().toggleCodeBlock().run();
          },
          editor.isActive("codeBlock"),
        )}
        {button("Divider", () => {
          editor.chain().focus().setHorizontalRule().run();
        })}
        {button("Link", () => {
          setLink(editor.getAttributes("link").href ?? "");
          setShowLink(!showLink);
        })}
        {button("Attach reference", () => setShowReference(!showReference))}
        {button(
          "Undo",
          () => {
            editor.chain().focus().undo().run();
          },
          undefined,
          !editor.can().undo(),
        )}
        {button(
          "Redo",
          () => {
            editor.chain().focus().redo().run();
          },
          undefined,
          !editor.can().redo(),
        )}
      </div>
      {showLink && (
        <fieldset className="note-link-panel">
          <legend>Link selected text</legend>
          <label>
            HTTP(S) URL
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          {button("Apply link", () => {
            try {
              editor
                .chain()
                .focus()
                .extendMarkRange("link")
                .setLink({ href: noteLink(link) })
                .run();
              setShowLink(false);
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          })}
          {button("Remove link", () => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            setShowLink(false);
          })}
        </fieldset>
      )}
      {showReference && (
        <fieldset className="note-reference-panel">
          <legend>Attach notebook evidence</legend>
          <label>
            Reference source
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Choose a source</option>
              {sources
                .filter((s) => !s.removed && s.current_revision)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
            </select>
          </label>
          {loading && <p role="status">Loading passages…</p>}
          <label>
            Reference passage
            <select
              value={passage}
              onChange={(e) => {
                setPassage(e.target.value);
                setQuote(
                  passages.find((p) => p.id === e.target.value)?.text ?? "",
                );
              }}
            >
              <option value="">Choose a passage</option>
              {passages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.locator} · {p.text.slice(0, 80)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Exact evidence quote
            <textarea
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
              rows={3}
            />
          </label>
          <p className="fine">
            Attach an exact excerpt. References stay with the note, but do not
            certify edited claims.
          </p>
          {button(
            "Insert reference",
            () => {
              const p = passages.find((p) => p.id === passage),
                index = p?.text.indexOf(quote) ?? -1;
              if (!p || !quote || index < 0) {
                setError("The quote must match the chosen passage exactly.");
                return;
              }
              const start = Array.from(p.text.slice(0, index)).length,
                citation = {
                  passageId: p.id,
                  quote,
                  start,
                  end: start + Array.from(quote).length,
                };
              editor
                .chain()
                .focus()
                .insertContent({ type: "citation", attrs: { citation } })
                .run();
              setShowReference(false);
              setError("");
            },
            undefined,
            !passage || !quote,
          )}
        </fieldset>
      )}
      <EditorContent editor={editor} className="rich-note-editor" />
      <p className="fine">
        {authoredReferenceNotice} Paste inserts plain text. Use the formatting
        controls or keyboard shortcuts; Backspace removes a selected reference.
      </p>
      <button className="primary" disabled={saving || !!start.error}>
        {saving ? "Saving…" : "Save note"}
      </button>
    </form>
  );
}
