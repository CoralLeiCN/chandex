import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { Store } from "../src/storage/store.ts";
import { editableNote } from "../src/domain/notes.ts";
import {
  NoteDraftWriter,
  type DraftStatus,
} from "../src/web/note-draft-writer.ts";

const input = (text: string) => ({
  artifactId: null,
  baseRevisionId: null,
  title: text,
  document: editableNote({ text }),
});
function setup(
  intercept?: (method: string, committed: () => Response) => Promise<Response>,
) {
  const root = mkdtempSync(os.tmpdir() + "/codeboom-draft-writer-");
  const store = new Store(root),
    n = store.createNotebook("Personal").id;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const id = String(url).split("/").at(-1)!,
      b = JSON.parse(String(init?.body));
    const committed = () => {
      try {
        const result =
          init?.method === "PUT"
            ? store.drafts.save(n, id, b)
            : store.drafts.discard(n, { id, version: b.version });
        return new Response(JSON.stringify(result ?? {}));
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 400,
        });
      }
    };
    return intercept ? intercept(init!.method!, committed) : committed();
  };
  return {
    store,
    n,
    close() {
      globalThis.fetch = original;
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("serial autosave retains edits made during a pending write; discard waits and cannot resurrect its draft", async () => {
  let release!: () => void,
    hold = true;
  const f = setup(async (method, commit) => {
    if (hold && method === "PUT")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return commit();
  });
  const writer = new NoteDraftWriter(f.n, () => {});
  try {
    writer.change(input("First"), true);
    const pending = writer.flush();
    writer.change(input("Latest"), true);
    hold = false;
    release();
    await pending;
    const drafts = f.store.drafts.list(f.n);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].title, "Latest");
    hold = true;
    writer.change(input("In flight at discard"), true);
    const writing = writer.flush();
    writer.change(input("Queued at discard"), true);
    const discard = writer.discard();
    hold = false;
    release();
    await writing;
    await discard;
    assert.equal(f.store.drafts.list(f.n).length, 0);
    await writer.flush();
    assert.equal(f.store.drafts.list(f.n).length, 0);
  } finally {
    writer.published();
    f.close();
  }
});

test("two windows recovering the same draft preserve their separate edits", async () => {
  const f = setup();
  const ref = f.store.drafts.save(f.n, "recovered", {
    ...input("Original"),
    version: 1,
  });
  const a = new NoteDraftWriter(f.n, () => {}, ref),
    b = new NoteDraftWriter(f.n, () => {}, ref);
  try {
    a.change(input("Window A"), true);
    await a.flush();
    b.change(input("Window B"), true);
    await b.flush();
    assert.deepEqual(
      f.store.drafts
        .list(f.n)
        .map((d) => d.title)
        .sort(),
      ["Window A", "Window B"],
    );
    await a.discard();
    assert.deepEqual(
      f.store.drafts.list(f.n).map((d) => d.title),
      ["Window B"],
    );
  } finally {
    a.published();
    b.published();
    f.close();
  }
});

test("lost autosave replies can be retried or explicitly discarded without duplicate or orphan drafts", async () => {
  let loseReply = true;
  const statuses: DraftStatus[] = [];
  const f = setup(async (method, commit) => {
    const response = commit();
    if (loseReply && method === "PUT") {
      loseReply = false;
      throw Error("Reply lost");
    }
    return response;
  });
  const writer = new NoteDraftWriter(f.n, (s) => statuses.push(s));
  const other = new NoteDraftWriter(f.n, () => {});
  const reverted = new NoteDraftWriter(f.n, () => {});
  try {
    writer.change(input("Retained"), true);
    await assert.rejects(writer.flush(), /Reply lost/);
    assert.equal(statuses.at(-1)?.state, "error");
    await writer.flush();
    assert.equal(f.store.drafts.list(f.n).length, 1);
    assert.equal(statuses.at(-1)?.state, "saved");
    loseReply = true;
    other.change(input("Discard after lost reply"), true);
    await assert.rejects(other.flush(), /Reply lost/);
    await other.discard();
    loseReply = true;
    reverted.change(input("Undo after lost reply"), true);
    await assert.rejects(reverted.flush(), /Reply lost/);
    reverted.change(input("Original"), false);
    await reverted.flush();
    assert.deepEqual(
      f.store.drafts.list(f.n).map((d) => d.title),
      ["Retained"],
    );
  } finally {
    writer.published();
    other.published();
    reverted.published();
    f.close();
  }
});

test("returning to the saved baseline removes recovery without publishing a revision", async () => {
  const f = setup();
  const writer = new NoteDraftWriter(f.n, () => {});
  try {
    writer.change(input("Changed"), true);
    await writer.flush();
    writer.change(input("Original"), false);
    await writer.flush();
    assert.equal(f.store.drafts.list(f.n).length, 0);
    assert.equal(f.store.view(f.n).artifacts.length, 0);
    writer.change(input("Another edit"), true);
    await writer.flush();
    assert.equal(f.store.drafts.list(f.n)[0].title, "Another edit");
  } finally {
    writer.published();
    f.close();
  }
});
