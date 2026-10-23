import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { once } from "node:events";
import net from "node:net";
import { Store } from "../src/storage/store.ts";
import { studyAnswer } from "./fixtures/study.ts";
import { structuredAnswer } from "./fixtures/structured.ts";
import { extract } from "../src/ingestion/extract.ts";
import { EXTRACTION_VERSION } from "../src/ingestion/version.ts";
import {
  NOTEBOOK_TITLE_LIMIT,
  NOTEBOOK_INSTRUCTIONS_LIMIT,
} from "../src/domain/notebooks.ts";
import { sourceViewer } from "../src/web/source-viewer.ts";
import { scanImage, scanPdf, scanLines } from "./fixtures/ocr.ts";
import { richFixture } from "./fixtures/notes.ts";
import { textPdf } from "./fixtures/pdf.ts";
import { srtCaptions, vttCaptions } from "./fixtures/captions.ts";
import {
  wordFixture,
  slidesFixture,
  workbookFixture,
  csvFixture,
  tsvFixture,
} from "./fixtures/office.ts";
import { createHash } from "node:crypto";
test("HTTP sessions, scoped imports, duplicate retry, stored notes and exports work end to end", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-api-"));
  const seed = new Store(root),
    seedNotebook = seed.createNotebook("Replay fixture").id;
  const seedJob = seed.beginImport(seedNotebook, "Evidence", "seed-import");
  const bytes = Buffer.from("Replay evidence");
  seed.publishImport(
    seedNotebook,
    seedJob.id,
    "Evidence",
    "text",
    null,
    bytes,
    await extract(bytes, "text"),
  );
  const seedRun = seed.createRun(
    seedNotebook,
    seed.view(seedNotebook).conversations[0].id,
    "A question",
    "answer",
    "",
    "seed-run",
  );
  seed.event(seedRun.id, { type: "progress", text: "before-cursor" });
  const cursor = seed.one("SELECT max(seq) AS seq FROM events").seq;
  seed.event(seedRun.id, { type: "progress", text: "after-cursor" });
  const quizConversation = seed.createConversation(seedNotebook).id;
  const quizRun = seed.createRun(
    seedNotebook,
    quizConversation,
    "Quiz",
    "quiz",
    "fixture",
    "quiz-seed",
    undefined,
    5,
  );
  seed.completeRun(
    quizRun.id,
    studyAnswer(
      seed.selectedPassages(seedNotebook, quizConversation)[0],
      "quiz",
    ),
  );
  const quizArtifact = seed.view(seedNotebook).artifacts[0];
  const structuredSeeds = ["mind-map", "data-table"].map((kind) => {
    const conversation = seed.createConversation(seedNotebook).id;
    const run = seed.createRun(
      seedNotebook,
      conversation,
      "Structure",
      kind,
      "fixture",
      "structured-" + kind,
    );
    seed.completeRun(
      run.id,
      structuredAnswer(
        seed.selectedPassages(seedNotebook, conversation)[0],
        kind as "mind-map" | "data-table",
      ),
    );
    return {
      kind,
      conversation,
      runId: run.id,
      artifact: seed
        .view(seedNotebook)
        .artifacts.find((a: any) => a.run_id === run.id),
    };
  });
  const driveNotebook = seed.createNotebook("Drive HTTP fixture").id;
  const driveBytes = wordFixture(),
    driveOrigin =
      "https://docs.google.com/document/d/Synthetic_HTTP_Drive/edit";
  const driveSeedJob = seed.beginImport(
    driveNotebook,
    "Saved Drive export",
    "drive-seed",
  );
  const driveSeedSource = seed.publishImport(
    driveNotebook,
    driveSeedJob.id,
    "Saved Drive export",
    "docx",
    driveOrigin,
    driveBytes,
    await extract(driveBytes, "docx"),
    undefined,
    undefined,
    {
      requestedUrl: driveOrigin,
      retrievedAt: "2026-10-10T12:00:00Z",
      drive: {
        provider: "google-drive",
        id: "Synthetic_HTTP_Drive",
        name: "Saved Drive export",
        mimeType: "application/vnd.google-apps.document",
        version: "12345678901234567890",
        modifiedTime: "2026-10-10T12:00:00Z",
        representation: "workspace-export",
        exportMimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sha256: createHash("sha256").update(driveBytes).digest("hex"),
      },
    },
  );
  const driveSeedRevision =
    seed.view(driveNotebook).sources[0].current_revision;
  const localTextNotebook = seed.createNotebook("Local text downloads").id;
  const localTextSources = await Promise.all(
    ["text", "markdown"].map(async (kind) => {
      const bytes = Buffer.from(`ID3 tags explained in this ${kind} source 🦉`);
      const job = seed.beginImport(localTextNotebook, kind, `local-${kind}`);
      const source = seed.publishImport(
        localTextNotebook,
        job.id,
        kind,
        kind,
        null,
        bytes,
        await extract(bytes, kind),
      );
      return { source, kind, bytes };
    }),
  );
  const historicalPdf = textPdf([["Historical PDF before URL refresh"]]);
  const refreshedSource = seed.publishImport(
    localTextNotebook,
    seed.beginImport(localTextNotebook, "Changing URL", "url-pdf").id,
    "Changing URL",
    "pdf",
    "https://example.com/changing-source",
    historicalPdf,
    await extract(historicalPdf, "pdf"),
  );
  const historicalPdfRevision = seed.one(
    "SELECT current_revision FROM sources WHERE id=?",
    refreshedSource,
  ).current_revision;
  const refreshedText = Buffer.from("ID3 tags explained after URL refresh");
  seed.publishImport(
    localTextNotebook,
    seed.beginImport(localTextNotebook, "Changing URL", "url-text").id,
    "Changing URL",
    "text",
    "https://example.com/changing-source",
    refreshedText,
    await extract(refreshedText, "text"),
    refreshedSource,
  );
  const historicalTextRevision = seed.one(
    "SELECT current_revision FROM sources WHERE id=?",
    refreshedSource,
  ).current_revision;
  const legacyText = Buffer.from("ID3 legacy text without recorded format");
  seed.publishImport(
    localTextNotebook,
    seed.beginImport(localTextNotebook, "Changing URL", "url-legacy-text").id,
    "Changing URL",
    "text",
    "https://example.com/changing-source",
    legacyText,
    await extract(legacyText, "text"),
    refreshedSource,
  );
  const legacyTextRevision = seed.one(
    "SELECT current_revision FROM sources WHERE id=?",
    refreshedSource,
  ).current_revision;
  const currentHtml = Buffer.from(
    "<html><head><title>Updated page</title></head><body><article><p>" +
      "This page now uses HTML rather than its earlier PDF and text representations. ".repeat(
        8,
      ) +
      "</p></article></body></html>",
  );
  seed.publishImport(
    localTextNotebook,
    seed.beginImport(localTextNotebook, "Changing URL", "url-html").id,
    "Changing URL",
    "html",
    "https://example.com/changing-source",
    currentHtml,
    await extract(currentHtml, "html"),
    refreshedSource,
  );
  seed.run("UPDATE revisions SET kind=NULL WHERE id=?", legacyTextRevision);
  seed.close();
  const runtimeStub = path.join(root, "runtime-stub.mjs");
  writeFileSync(
    runtimeStub,
    `import { CodexClient } from ${JSON.stringify(pathToFileURL(path.resolve("src/codex/client.ts")).href)};
CodexClient.prototype.run = async function () {
  throw new Error("Model execution disabled in HTTP regression test.");
};
`,
  );
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const base = "http://127.0.0.1:" + port;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", runtimeStub, "src/server/main.ts"],
    {
      env: {
        ...process.env,
        CODEBOOM_DATA_DIR: root,
        CODEBOOM_PORT: String(port),
        CODEBOOM_GOOGLE_DESKTOP_CLIENT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw new Error("API process exited");
      }),
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("API startup timeout")),
          10000,
        );
        t.unref();
      }),
    ]);
    assert.equal((await fetch(base + "/api/notebooks")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/session", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    const session = await fetch(base + "/api/session"),
      cookie = session.headers.get("set-cookie")!.split(";")[0];
    const stream = await fetch(
      base +
        "/api/notebooks/" +
        seedNotebook +
        "/runs/" +
        seedRun.id +
        "/events",
      { headers: { Cookie: cookie, "Last-Event-ID": String(cursor) } },
    );
    const replay = await stream.text();
    assert.ok(!replay.includes("before-cursor"));
    assert.ok(replay.includes("after-cursor"));
    assert.ok(replay.includes("interrupted"));
    const call = async (route: string, method = "GET", body?: unknown) => {
      const r = await fetch(base + "/api" + route, {
        method,
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json() };
    };
    for (const kind of ["slides", "infographic"]) {
      const route = `/notebooks/${seedNotebook}/conversations/${quizConversation}/runs`;
      const payload = {
        question: `Create ${kind}`,
        kind,
        idempotency: `http-create-${kind}`,
      };
      const created = await call(route, "POST", payload);
      assert.equal(created.status, 202, JSON.stringify(created.data));
      assert.equal(created.data.kind, kind);
      assert.equal(created.data.question, payload.question);
      assert.equal(created.data.idempotency, payload.idempotency);
      assert.equal(
        (await call(route, "POST", payload)).data.id,
        created.data.id,
      );
      const persisted = (
        await call(`/notebooks/${seedNotebook}`)
      ).data.runs.find((run: any) => run.id === created.data.id);
      assert.equal(persisted.kind, kind);
      assert.equal(persisted.status, "failed");
      assert.match(persisted.error, /Model execution disabled/);
    }
    for (const { source, kind, bytes } of localTextSources) {
      const original = await fetch(
        `${base}/api/notebooks/${localTextNotebook}/sources/${source}/original`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(original.status, 200);
      assert.ok(
        original.headers
          .get("content-disposition")
          ?.endsWith(`.${kind === "text" ? "txt" : "md"}"`),
      );
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    }
    for (const [suffix, extension, bytes] of [
      [`?revision=${historicalPdfRevision}`, "pdf", historicalPdf],
      [`?revision=${historicalTextRevision}`, "txt", refreshedText],
      [`?revision=${legacyTextRevision}`, "bin", legacyText],
      ["", "html", currentHtml],
    ] as const) {
      const original = await fetch(
        `${base}/api/notebooks/${localTextNotebook}/sources/${refreshedSource}/original${suffix}`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(original.status, 200);
      assert.ok(
        original.headers.get("content-disposition")?.endsWith(`.${extension}"`),
      );
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    }
    assert.equal((await fetch(base + "/api/drive")).status, 401);
    assert.deepEqual((await call("/drive")).data, {
      configured: false,
      state: "unavailable",
      error: "Google Drive connection is not configured.",
    });
    assert.equal(
      (
        await fetch(base + "/api/drive/connect", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://foreign.example" },
        })
      ).status,
      403,
    );
    assert.equal((await call("/drive/connect", "POST", {})).status, 400);
    const savedDrive = (
      await call(`/notebooks/${driveNotebook}/sources/${driveSeedSource}`)
    ).data;
    assert.equal(
      JSON.parse(savedDrive.revisions[0].provider_metadata).version,
      "12345678901234567890",
    );
    assert.equal(
      savedDrive.passages[0].drive.representation,
      "workspace-export",
    );
    const exportedDrive = await fetch(
      base +
        `/api/notebooks/${driveNotebook}/sources/${driveSeedSource}/original?revision=${driveSeedRevision}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(exportedDrive.status, 200);
    assert.match(exportedDrive.headers.get("content-disposition")!, /\.docx"$/);
    assert.deepEqual(
      Buffer.from(await exportedDrive.arrayBuffer()),
      driveBytes,
    );
    const driveRefresh = await call(
      `/notebooks/${driveNotebook}/sources/${driveSeedSource}/refresh`,
      "POST",
      {},
    );
    assert.equal(driveRefresh.status, 202);
    assert.equal(driveRefresh.data.input_kind, "drive");
    const driveDeadline = Date.now() + 2000;
    let driveView: any;
    do {
      driveView = (await call(`/notebooks/${driveNotebook}`)).data;
      if (
        driveView.jobs.find((j: any) => j.id === driveRefresh.data.id)
          ?.status !== "processing"
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    } while (Date.now() < driveDeadline);
    assert.equal(
      driveView.jobs.find((j: any) => j.id === driveRefresh.data.id).status,
      "failed",
    );
    assert.equal(driveView.sources[0].current_revision, driveSeedRevision);
    assert.equal(
      (
        await call(`/notebooks/${driveNotebook}/import`, "POST", {
          title: "Foreign",
          kind: "drive",
          driveUrl: "https://foreign.example/file",
          idempotency: "foreign-drive",
        })
      ).status,
      400,
    );
    const richSource = (await call(`/notebooks/${seedNotebook}`)).data
      .sources[0];
    const richPassage = (
      await call(`/notebooks/${seedNotebook}/sources/${richSource.id}`)
    ).data.passages[0];
    const richCitation = {
      passageId: richPassage.id,
      quote: richPassage.text,
      start: 0,
      end: Array.from(richPassage.text).length,
    };
    const createdRich = await call(
      `/notebooks/${seedNotebook}/artifacts`,
      "POST",
      { title: "Rich HTTP note", document: richFixture(richCitation) },
    );
    assert.equal(createdRich.status, 201);
    const richRoute = `/notebooks/${seedNotebook}/artifacts/${createdRich.data.id}`;
    assert.equal(
      (await fetch(base + "/api" + richRoute + "/revisions")).status,
      401,
    );
    const firstHistory = (await call(richRoute + "/revisions")).data;
    const baseRich = firstHistory.results[0].id;
    assert.equal(
      (
        await fetch(base + "/api" + richRoute + "/conversation", {
          method: "POST",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call(richRoute + "/conversation", "POST", {
          revisionId: "missing",
        })
      ).status,
      400,
    );
    const noteChat = await call(richRoute + "/conversation", "POST", {
      revisionId: baseRich,
    });
    assert.equal(noteChat.status, 200);
    assert.equal(
      (
        await call(richRoute + "/conversation", "POST", {
          revisionId: baseRich,
        })
      ).data.id,
      noteChat.data.id,
    );
    const noteChatView = (await call(`/notebooks/${seedNotebook}`)).data;
    const pinned = noteChatView.conversations.find(
      (c: any) => c.id === noteChat.data.id,
    );
    assert.equal(pinned.note_revision, baseRich);
    assert.deepEqual(pinned.selected, [pinned.note_source]);
    assert.equal(
      (
        await call(
          `/notebooks/${seedNotebook}/conversations/${pinned.id}`,
          "PATCH",
          { selected: [] },
        )
      ).status,
      400,
    );
    assert.equal(firstHistory.results[0].authored, 1);
    assert.equal((await call(richRoute + "/revisions?limit=51")).status, 400);
    const editedRich = structuredClone(richFixture(richCitation));
    editedRich.doc.content![0].content![0].text = "Changed HTTP note";
    assert.equal(
      (
        await call(richRoute, "PATCH", {
          title: "Changed HTTP note",
          document: editedRich,
          baseRevisionId: baseRich,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(richRoute, "PATCH", {
          title: "Missing base",
          document: editedRich,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(richRoute, "PATCH", {
          title: "Stale",
          document: editedRich,
          baseRevisionId: baseRich,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(richRoute, "PATCH", {
          title: "Stale plain",
          text: "Legacy",
          baseRevisionId: baseRich,
        })
      ).status,
      400,
    );
    const currentRich = (await call(richRoute + "/revisions")).data.results[0]
      .id;
    assert.equal(
      (await call(richRoute + "/revisions/" + baseRich)).data.content.doc
        .content[0].content[0].text,
      "Research 🦉",
    );
    const historicalRichExport = await fetch(
      `${base}/api${richRoute}/export?revision=${baseRich}`,
      { headers: { Cookie: cookie } },
    );
    assert.match(await historicalRichExport.text(), /## Research 🦉/);
    const formattedRoute = `${base}/api${richRoute}/export?format=html`,
      formattedCurrent = await fetch(formattedRoute, {
        headers: { Cookie: cookie },
      }),
      formattedText = await formattedCurrent.text();
    assert.equal(formattedCurrent.status, 200);
    assert.equal(
      formattedCurrent.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.equal(
      formattedCurrent.headers.get("content-disposition"),
      'attachment; filename="codeboom-note.html"',
    );
    assert.equal(formattedCurrent.headers.get("cache-control"), "no-store");
    assert.equal(
      formattedCurrent.headers.get("x-content-type-options"),
      "nosniff",
    );
    assert.ok(formattedText.includes(currentRich));
    assert.match(formattedText, /Changed HTTP note/);
    const formattedHistory = await fetch(
        formattedRoute + "&revision=" + baseRich,
        { headers: { Cookie: cookie } },
      ),
      historicalHtml = await formattedHistory.text();
    assert.equal(formattedHistory.status, 200);
    assert.ok(historicalHtml.includes(baseRich));
    assert.match(historicalHtml, /Historical revision/);
    assert.match(historicalHtml, /<h2>Research 🦉<\/h2>/);
    assert.doesNotMatch(historicalHtml, /Changed HTTP note/);
    assert.equal((await fetch(formattedRoute)).status, 401);
    assert.equal(
      (
        await fetch(formattedRoute.replace(seedNotebook, "unknown-notebook"), {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(formattedRoute + "&revision=" + quizArtifact.revision_id, {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(formattedRoute.replace("format=html", "format=pdf"), {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    assert.equal((await call(richRoute + "/revisions")).data.results.length, 2);
    assert.equal(
      (
        await call(richRoute + "/restore", "POST", {
          revisionId: baseRich,
          baseRevisionId: currentRich,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(richRoute + "/restore", "POST", {
          revisionId: baseRich,
          baseRevisionId: currentRich,
        })
      ).status,
      400,
    );
    const otherRich = (
      await call("/notebooks", "POST", { title: "Other rich owner" })
    ).data.id;
    assert.equal(
      (
        await call(`/notebooks/${otherRich}/artifacts`, "POST", {
          title: "Foreign citation",
          document: richFixture(richCitation),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          `/notebooks/${otherRich}/artifacts/${createdRich.data.id}/revisions`,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          `/notebooks/${otherRich}/artifacts/${createdRich.data.id}/revisions/${baseRich}`,
        )
      ).status,
      400,
    );
    const forgedRich = structuredClone(richFixture(richCitation));
    forgedRich.doc.content![1].content!.find(
      (node) => node.type === "citation",
    )!.attrs!.citation.quote = "Forged reference";
    assert.equal(
      (
        await call(`/notebooks/${seedNotebook}/artifacts`, "POST", {
          title: "Forged",
          document: forgedRich,
        })
      ).status,
      400,
    );
    const richPromotion = (
      await call(richRoute + "/promote", "POST", {
        revisionId: (
          await call(`/notebooks/${seedNotebook}`)
        ).data.artifacts.find((a: any) => a.id === createdRich.data.id)
          .revision_id,
      })
    ).data;
    let richPromotionView: any;
    for (let i = 0; i < 80; i++) {
      richPromotionView = (await call(`/notebooks/${seedNotebook}`)).data;
      if (
        richPromotionView.jobs.find((j: any) => j.id === richPromotion.id)
          ?.status !== "processing"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const richDerived = richPromotionView.sources.find(
      (s: any) => s.derived_from === createdRich.data.id,
    );
    assert.ok(richDerived);
    const richAncestry = (
      await call(
        `/notebooks/${seedNotebook}/sources/${richDerived.id}/derivation`,
      )
    ).data;
    assert.equal(richAncestry.authored, true);
    assert.equal(richAncestry.origin, "user");
    assert.equal(richAncestry.content.format, "rich-note");
    assert.equal(richAncestry.evidence[0].quote, richPassage.text);
    assert.equal((await fetch(base + "/api/library?q=evidence")).status, 401);
    assert.equal((await fetch(base + "/api/templates")).status, 401);
    const recipe = {
      title: "HTTP recipe",
      description: "Settings only",
      instructions: "Preserve uncertainty",
      tags: [" Café ", "CAFÉ"],
      questions: ["What is uncertain?"],
    };
    const saved = await call("/templates", "POST", { recipe });
    assert.equal(saved.status, 201);
    assert.deepEqual(saved.data.tags, ["Café"]);
    const templated = await call("/notebooks", "POST", {
      title: "HTTP template notebook",
      templateId: saved.data.id,
      templateVersion: 1,
    });
    assert.equal(templated.status, 201);
    assert.equal(templated.data.instructions, recipe.instructions);
    const templateView = (await call("/notebooks/" + templated.data.id)).data;
    assert.equal(templateView.sources.length, 0);
    assert.equal(templateView.artifacts.length, 0);
    assert.equal(templateView.conversations.length, 1);
    assert.deepEqual(templateView.starterQuestions, recipe.questions);
    const longInstructions = "🦉".repeat(NOTEBOOK_INSTRUCTIONS_LIMIT);
    const longTitle = "🦉".repeat(NOTEBOOK_TITLE_LIMIT);
    const longRecipe = {
      ...recipe,
      title: longTitle,
      instructions: longInstructions,
    };
    const longTemplate = await call("/templates", "POST", {
      recipe: longRecipe,
    });
    assert.equal(longTemplate.status, 201);
    const longNotebook = await call("/notebooks", "POST", {
      title: longTemplate.data.title,
      templateId: longTemplate.data.id,
      templateVersion: longTemplate.data.version,
      instructions: longTemplate.data.instructions,
      tags: longTemplate.data.tags,
      questions: longTemplate.data.questions,
    });
    assert.equal(longNotebook.status, 201, JSON.stringify(longNotebook.data));
    assert.equal(longNotebook.data.title, longTitle);
    assert.equal(longNotebook.data.instructions, longInstructions);
    const longRoute = `/notebooks/${longNotebook.data.id}`;
    const unchangedInstructions = await call(longRoute, "PATCH", {
      title: longTitle,
      instructions: longInstructions,
    });
    assert.equal(unchangedInstructions.status, 200);
    assert.equal(unchangedInstructions.data.title, longTitle);
    assert.equal(unchangedInstructions.data.instruction_version, 1);
    const editedInstructions = ` \n${"🦉".repeat(NOTEBOOK_INSTRUCTIONS_LIMIT - 4)}\n `;
    const editedLongNotebook = await call(longRoute, "PATCH", {
      instructions: editedInstructions,
    });
    assert.equal(editedLongNotebook.status, 200);
    assert.equal(editedLongNotebook.data.instructions, editedInstructions);
    assert.equal(editedLongNotebook.data.instruction_version, 2);
    for (const invalidInstructions of [
      longInstructions + "x",
      "Invalid\0instructions",
    ]) {
      assert.equal(
        (
          await call("/templates", "POST", {
            recipe: { ...longRecipe, instructions: invalidInstructions },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call("/notebooks", "POST", {
            title: "Invalid instruction length",
            instructions: invalidInstructions,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call(longRoute, "PATCH", {
            title: "Must not change",
            instructions: invalidInstructions,
          })
        ).status,
        400,
      );
    }
    const preservedLongNotebook = (await call(longRoute)).data;
    assert.equal(preservedLongNotebook.title, longTitle);
    assert.equal(preservedLongNotebook.instructions, editedInstructions);
    assert.equal(preservedLongNotebook.instruction_version, 2);
    for (const invalidTitle of [longTitle + "x", " "]) {
      assert.equal(
        (
          await call("/templates", "POST", {
            recipe: { ...longRecipe, title: invalidTitle },
          })
        ).status,
        400,
      );
      assert.equal(
        (await call("/notebooks", "POST", { title: invalidTitle })).status,
        400,
      );
      assert.equal(
        (await call(longRoute, "PATCH", { title: invalidTitle })).status,
        400,
      );
    }
    assert.equal((await call(longRoute)).data.title, longTitle);
    assert.equal(
      (
        await call("/notebooks/" + templated.data.id, "PATCH", {
          tags: [false],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/templates/" + saved.data.id, "PATCH", {
          version: 1,
          recipe: { ...recipe, instructions: "New instructions" },
        })
      ).data.version,
      2,
    );
    assert.equal(
      (
        await call("/notebooks", "POST", {
          title: "Stale HTTP",
          templateId: saved.data.id,
          templateVersion: 1,
        })
      ).status,
      400,
    );
    const catalog = (await call("/templates")).data;
    assert.equal(
      (await call("/templates/" + catalog[0].id, "DELETE", { version: 1 }))
        .status,
      400,
    );
    const library = await call("/library?q=HTTP&tag=CAF%C3%89");
    assert.equal(library.status, 200);
    assert.equal(library.data.results[0].notebookId, templated.data.id);
    assert.equal((await call("/library?limit=51")).status, 400);
    assert.equal((await call("/library?archived=maybe")).status, 400);
    assert.equal(
      (await call("/templates/" + saved.data.id, "DELETE", { version: 2 }))
        .status,
      200,
    );
    assert.equal(
      (await call("/notebooks/" + templated.data.id)).data.templateSnapshot
        .version,
      1,
    );
    for (const fixture of structuredSeeds) {
      const replayRun = await call(
        `/notebooks/${seedNotebook}/conversations/${fixture.conversation}/runs`,
        "POST",
        {
          question: "Structure",
          kind: fixture.kind,
          model: "fixture",
          idempotency: "structured-" + fixture.kind,
        },
      );
      assert.equal(replayRun.status, 202);
      assert.equal(replayRun.data.id, fixture.runId);
      const exported = await fetch(
        `${base}/api/notebooks/${seedNotebook}/artifacts/${fixture.artifact.id}/export`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(exported.status, 200);
      assert.match(
        await exported.text(),
        fixture.kind === "mind-map"
          ? /Relationship to Evidence: states/
          : /Not stated/,
      );
      assert.equal(
        (
          await call(
            `/notebooks/${seedNotebook}/artifacts/${fixture.artifact.id}/promote`,
            "POST",
            { revisionId: fixture.artifact.revision_id },
          )
        ).status,
        202,
      );
      let promoted: any;
      for (let i = 0; i < 100; i++) {
        const state = await call(`/notebooks/${seedNotebook}`);
        promoted = state.data.sources.find(
          (s: any) => s.derived_from === fixture.artifact.id,
        );
        if (promoted) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(promoted);
      const origin = await call(
        `/notebooks/${seedNotebook}/sources/${promoted.id}/derivation?revision=${promoted.current_revision}`,
      );
      assert.equal(origin.data.content.kind, fixture.kind);
      assert.equal(origin.data.revisionId, fixture.artifact.revision_id);
      assert.equal(origin.data.evidence.length, 3);
      assert.ok(origin.data.evidence.every((e: any) => !e.unavailable));
    }
    assert.equal(
      (
        await call(
          `/notebooks/${seedNotebook}/conversations/${quizConversation}/runs`,
          "POST",
          {
            question: "Count guard",
            kind: "quiz",
            itemCount: null,
            idempotency: "invalid-null-count",
          },
        )
      ).status,
      400,
    );
    const quizPromotion = await call(
      `/notebooks/${seedNotebook}/artifacts/${quizArtifact.id}/promote`,
      "POST",
      { revisionId: quizArtifact.revision_id },
    );
    assert.equal(quizPromotion.status, 202);
    let promotedQuiz: any;
    for (let i = 0; i < 100; i++) {
      const state = await call(`/notebooks/${seedNotebook}`);
      promotedQuiz = state.data.sources.find(
        (source: any) => source.derived_from === quizArtifact.id,
      );
      if (promotedQuiz) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(promotedQuiz);
    const quizDerivation = await call(
      `/notebooks/${seedNotebook}/sources/${promotedQuiz.id}/derivation?revision=${promotedQuiz.current_revision}`,
    );
    assert.equal(quizDerivation.data.content.kind, "quiz");
    assert.equal(quizDerivation.data.evidence.length, 3);
    const quizPassages = await call(
      `/notebooks/${seedNotebook}/sources/${promotedQuiz.id}`,
    );
    assert.ok(quizPassages.data.passages.length > 0);
    assert.doesNotMatch(
      JSON.stringify(quizPassages.data.passages),
      /candidate answer absent|distractor absent/,
    );
    const attemptRoute = `/notebooks/${seedNotebook}/artifacts/${quizArtifact.id}/attempts`;
    const qa = await call(attemptRoute, "POST", {
      revisionId: quizArtifact.revision_id,
      idempotency: "quiz-attempt",
    });
    assert.equal(qa.status, 201);
    assert.equal(
      (
        await call(attemptRoute + "/extra", "POST", {
          revisionId: quizArtifact.revision_id,
          idempotency: "bad-route",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(attemptRoute, "POST", {
          revisionId: quizArtifact.revision_id,
          idempotency: "quiz-attempt",
        })
      ).data.id,
      qa.data.id,
    );
    assert.equal(
      (
        await call(attemptRoute + "/" + qa.data.id, "PATCH", {
          answers: { unknown: "correct" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(attemptRoute + "/" + qa.data.id, "PATCH", {
          answers: { "item-1": "correct" },
          submit: "true",
        })
      ).status,
      400,
    );
    const submitted = await call(attemptRoute + "/" + qa.data.id, "PATCH", {
      answers: { "item-1": "correct" },
      submit: true,
    });
    assert.equal(submitted.data.score, 1);
    assert.equal(
      (
        await call(attemptRoute + "/" + qa.data.id, "PATCH", {
          answers: { "item-1": "wrong" },
          submit: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(attemptRoute, "POST", {
          revisionId: "foreign",
          idempotency: "foreign",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/notebooks", {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: '{"title":"Forbidden"}',
        })
      ).status,
      403,
    );
    const n = (await call("/notebooks", "POST", { title: "API fixture" })).data
      .id;
    const officeNotebook = (
      await call("/notebooks", "POST", { title: "Office HTTP imports" })
    ).data.id;
    const finishImport = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const state = (await call(`/notebooks/${officeNotebook}`)).data;
        const job = state.jobs.find((j: any) => j.id === id);
        if (job.status !== "processing") return { job, state };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Office import did not settle");
    };
    for (const [kind, bytes] of [
      ["docx", wordFixture()],
      ["pptx", slidesFixture()],
      ["xlsx", workbookFixture()],
      ["csv", csvFixture()],
      ["tsv", tsvFixture()],
    ] as const) {
      const payload = {
        title: `Fixture.${kind}`,
        kind,
        base64: bytes.toString("base64"),
        idempotency: `office-${kind}`,
      };
      const submitted = await call(
        `/notebooks/${officeNotebook}/import`,
        "POST",
        payload,
      );
      assert.equal(submitted.status, 202);
      const { job, state } = await finishImport(submitted.data.id);
      assert.equal(job.status, "completed", JSON.stringify(job));
      const source = state.sources.find((s: any) => s.id === job.source_id);
      assert.equal(source.kind, kind);
      assert.ok(source.warnings.length);
      const detail = (
        await call(`/notebooks/${officeNotebook}/sources/${source.id}`)
      ).data;
      assert.ok(detail.passages.length);
      const viewer = sourceViewer(detail);
      assert.deepEqual(viewer.warnings, source.warnings);
      assert.equal(viewer.provenance.extractionVersion, EXTRACTION_VERSION);
      assert.match(viewer.provenance.originalHash, /^[0-9a-f]{64}$/);
      assert.ok(detail.passages.some((p: any) => p.text.includes("🦉")));
      const original = await fetch(
        `${base}/api/notebooks/${officeNotebook}/sources/${source.id}/original?revision=${viewer.provenance.revisionId}`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(original.status, 200);
      assert.ok(
        original.headers.get("content-disposition")?.endsWith(`.${kind}"`),
      );
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
      assert.equal(
        (await call(`/notebooks/${officeNotebook}/import`, "POST", payload))
          .data.id,
        job.id,
      );
      const duplicate = await call(
        `/notebooks/${officeNotebook}/import`,
        "POST",
        { ...payload, idempotency: `office-duplicate-${kind}` },
      );
      assert.equal(
        (await finishImport(duplicate.data.id)).job.status,
        "duplicate",
      );
      assert.equal(
        (
          await call(
            `/notebooks/${officeNotebook}/jobs/${duplicate.data.id}/duplicate`,
            "POST",
            { action: "reuse" },
          )
        ).status,
        200,
      );
    }
    const failed = await call(`/notebooks/${officeNotebook}/import`, "POST", {
      title: "Bad.docx",
      kind: "docx",
      base64: Buffer.from("PRIVATE_OFFICE_CANARY").toString("base64"),
      idempotency: "bad-office",
    });
    const failedState = await finishImport(failed.data.id);
    assert.equal(failedState.job.status, "failed");
    assert.equal(failedState.state.sources.length, 5);
    assert.doesNotMatch(failedState.job.error, /PRIVATE_OFFICE_CANARY/);
    const retried = await call(`/notebooks/${officeNotebook}/import`, "POST", {
      title: "Corrected.docx",
      kind: "docx",
      base64: wordFixture().toString("base64"),
      idempotency: "office-retry",
      retryOf: failed.data.id,
    });
    const retryJob = (await finishImport(retried.data.id)).job;
    assert.equal(retryJob.retry_of, failed.data.id);
    assert.equal(retryJob.status, "duplicate");
    assert.equal(
      (
        await call(`/notebooks/${officeNotebook}/import`, "POST", {
          title: "Macros",
          kind: "xlsm",
          text: "Unsupported",
          idempotency: "macro-import",
        })
      ).status,
      400,
    );
    let ocrPurgeRoute = "";
    for (const [label, kind, bytes] of [
      ["PNG", "image", scanImage()],
      ["JPEG", "image", scanImage("jpeg")],
      ["WebP", "image", scanImage("webp")],
      ["Scanned PDF", "pdf", scanPdf([{ native: "Qualified report" }])],
    ] as const) {
      const payload = {
        title: label,
        kind,
        base64: bytes.toString("base64"),
        idempotency: "ocr-api-" + label,
      };
      const submitted = await call(
        `/notebooks/${officeNotebook}/import`,
        "POST",
        payload,
      );
      assert.equal(submitted.status, 202);
      const { job, state } = await finishImport(submitted.data.id);
      assert.equal(job.status, "completed", JSON.stringify(job));
      const source = state.sources.find((s: any) => s.id === job.source_id);
      assert.equal(source.kind, kind);
      assert.match(
        source.warnings.join(" "),
        /English.*not an accuracy guarantee/,
      );
      const detail = (
        await call(`/notebooks/${officeNotebook}/sources/${source.id}`)
      ).data;
      const viewer = sourceViewer(detail);
      assert.equal(viewer.provenance.extractionVersion, EXTRACTION_VERSION);
      const originalRoute = `/notebooks/${officeNotebook}/sources/${source.id}/original?revision=${viewer.provenance.revisionId}`;
      if (label === "Scanned PDF") ocrPurgeRoute = originalRoute;
      const original = await fetch(base + "/api" + originalRoute, {
        headers: { Cookie: cookie },
      });
      assert.equal(original.status, 200);
      assert.equal(
        original.headers.get("content-type"),
        "application/octet-stream",
      );
      assert.match(
        original.headers.get("content-disposition")!,
        /^attachment; filename="snapshot-/,
      );
      assert.equal(original.headers.get("cache-control"), "no-store");
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
      assert.equal((await fetch(base + "/api" + originalRoute)).status, 401);
      assert.equal(
        (
          await call(
            `/notebooks/${seedNotebook}/sources/${source.id}/original?revision=${viewer.provenance.revisionId}`,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            originalRoute.replace(
              viewer.provenance.revisionId,
              "missing-revision",
            ),
          )
        ).status,
        400,
      );
      for (const line of scanLines)
        assert.ok(viewer.passages.some((p: any) => p.text.includes(line)));
      assert.deepEqual(viewer.warnings, source.warnings);
      assert.equal(
        (await call(`/notebooks/${officeNotebook}/import`, "POST", payload))
          .data.id,
        job.id,
      );
    }
    const badOcr = await call(`/notebooks/${officeNotebook}/import`, "POST", {
      title: "Broken scan",
      kind: "image",
      base64: Buffer.from("PRIVATE_OCR_CANARY").toString("base64"),
      idempotency: "ocr-api-bad",
    });
    const badOcrState = await finishImport(badOcr.data.id);
    assert.equal(badOcrState.job.status, "failed");
    assert.equal(badOcrState.state.sources.length, 9);
    assert.doesNotMatch(badOcrState.job.error, /PRIVATE_OCR_CANARY/);
    const retriedOcr = await call(
      `/notebooks/${officeNotebook}/import`,
      "POST",
      {
        title: "Corrected scan",
        kind: "image",
        base64: scanImage().toString("base64"),
        idempotency: "ocr-api-retry",
        retryOf: badOcr.data.id,
      },
    );
    const retriedOcrJob = (await finishImport(retriedOcr.data.id)).job;
    assert.equal(retriedOcrJob.retry_of, badOcr.data.id);
    assert.equal(retriedOcrJob.status, "duplicate");
    assert.equal(
      (
        await call(
          ocrPurgeRoute.split("/original")[0] + "?purge=true",
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal((await call(ocrPurgeRoute)).status, 400);
    const createdNotebook = (await call("/notebooks/" + n)).data;
    assert.equal(createdNotebook.instruction_version, 1);
    assert.equal(createdNotebook.created, createdNotebook.updated);
    for (const instructions of ["Audience A", "Audience B", "Audience A"])
      assert.equal(
        (await call("/notebooks/" + n, "PATCH", { instructions })).status,
        200,
      );
    const editedNotebook = (await call("/notebooks/" + n)).data;
    assert.equal(editedNotebook.instruction_version, 4);
    const noOp = (
      await call("/notebooks/" + n, "PATCH", {
        title: editedNotebook.title,
        instructions: "Audience A",
      })
    ).data;
    assert.equal(noOp.instruction_version, 4);
    assert.equal(noOp.generation, editedNotebook.generation);
    assert.equal(noOp.updated, editedNotebook.updated);
    const payload = {
      title: "Evidence",
      kind: "paste",
      text: "The release uses SQLite.",
      idempotency: "same-import",
    };
    const job = await call("/notebooks/" + n + "/import", "POST", payload);
    assert.equal(
      (await call("/notebooks/" + n + "/import", "POST", payload)).data.id,
      job.data.id,
    );
    let view: any;
    for (let i = 0; i < 80; i++) {
      view = (await call("/notebooks/" + n)).data;
      if (view.jobs[0].status !== "processing") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(view.jobs[0].status, "completed");
    assert.equal(view.sources.length, 1);
    const other = (await call("/notebooks", "POST", { title: "Other" })).data
      .id;
    assert.equal(
      (await call("/notebooks/" + other + "/sources/" + view.sources[0].id))
        .status,
      400,
    );
    for (const action of ["reuse", "dismiss"]) {
      const duplicate = (
        await call("/notebooks/" + n + "/import", "POST", {
          ...payload,
          idempotency: "duplicate-" + action,
        })
      ).data;
      let offer: any;
      for (let i = 0; i < 80; i++) {
        view = (await call("/notebooks/" + n)).data;
        offer = view.jobs.find((j: any) => j.id === duplicate.id);
        if (offer.status !== "processing") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(offer.status, "duplicate");
      assert.equal(view.sources.length, 1);
      assert.equal(
        (
          await call("/notebooks/" + n + "/import", "POST", {
            ...payload,
            idempotency: "duplicate-" + action,
          })
        ).data.id,
        duplicate.id,
      );
      assert.equal(
        (
          await call(
            "/notebooks/" + other + "/jobs/" + duplicate.id + "/duplicate",
            "POST",
            { action },
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            "/notebooks/" + n + "/jobs/" + duplicate.id + "/duplicate",
            "POST",
            { action: "invented" },
          )
        ).status,
        400,
      );
      const resolved = await call(
        "/notebooks/" + n + "/jobs/" + duplicate.id + "/duplicate",
        "POST",
        { action },
      );
      assert.equal(
        resolved.data.status,
        action === "reuse" ? "completed" : "dismissed",
      );
      assert.equal(
        (
          await call(
            "/notebooks/" + n + "/jobs/" + duplicate.id + "/duplicate",
            "POST",
            { action },
          )
        ).status,
        200,
      );
    }
    const note = (
      await call("/notebooks/" + n + "/artifacts", "POST", {
        title: "My note",
        text: "Local notes persist.",
      })
    ).data.id;
    const exported = await fetch(
      base + "/api/notebooks/" + n + "/artifacts/" + note + "/export",
      { headers: { Cookie: cookie } },
    );
    assert.match(await exported.text(), /# My note\n\nLocal notes persist/);
    const invalid = await call("/notebooks/" + n + "/import", "POST", {
      ...payload,
      kind: "exe",
      idempotency: "invalid",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await call("/notebooks/" + n)).data.jobs.length, 3);
    const promotion = (
      await call(
        "/notebooks/" + n + "/artifacts/" + note + "/promote",
        "POST",
        {
          revisionId: (await call("/notebooks/" + n)).data.artifacts.find(
            (a: any) => a.id === note,
          ).revision_id,
        },
      )
    ).data;
    await call("/notebooks/" + n + "/artifacts/" + note, "PATCH", {
      title: "Edited title",
      text: "Changed after promotion.",
      baseRevisionId: (await call("/notebooks/" + n)).data.artifacts.find(
        (a: any) => a.id === note,
      ).revision_id,
    });
    for (let i = 0; i < 80; i++) {
      view = (await call("/notebooks/" + n)).data;
      if (
        view.jobs.find((j: any) => j.id === promotion.id).status !==
        "processing"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const promoted = view.sources.find((s: any) => s.derived_from === note);
    assert.ok(promoted);
    const route =
      "/notebooks/" +
      n +
      "/sources/" +
      promoted.id +
      "/derivation?revision=" +
      promoted.current_revision;
    const derivation = await call(route);
    assert.equal(derivation.status, 200);
    assert.equal(derivation.data.title, "My note");
    assert.deepEqual(derivation.data.content, { text: "Local notes persist." });
    assert.equal(derivation.data.authored, true);
    assert.equal(derivation.data.artifactId, note);
    assert.deepEqual(derivation.data.evidence, []);
    assert.equal((await call(route.replace(n, other))).status, 400);
    assert.equal(
      (
        await call(
          route.replace(
            promoted.current_revision,
            view.sources[0].current_revision,
          ),
        )
      ).status,
      400,
    );
    const rejectedUrl = (
      await call("/notebooks/" + n + "/import", "POST", {
        title: "Unavailable URL",
        kind: "url",
        url: "http://127.0.0.1/private",
        idempotency: "blocked-url",
      })
    ).data;
    const waitForJob = async (id: string) => {
      for (let i = 0; i < 80; i++) {
        view = (await call("/notebooks/" + n)).data;
        const record = view.jobs.find((j: any) => j.id === id);
        if (record.status !== "processing") return record;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Import did not finish");
    };
    const originalFailure = await waitForJob(rejectedUrl.id);
    assert.equal(originalFailure.status, "failed");
    assert.equal(originalFailure.type, "import");
    assert.ok(originalFailure.started && originalFailure.ended);
    const retryRoute = "/notebooks/" + n + "/jobs/" + rejectedUrl.id + "/retry";
    assert.equal(
      (
        await call(retryRoute.replace(n, other), "POST", {
          idempotency: "foreign-retry",
        })
      ).status,
      400,
    );
    const urlRetry = await call(retryRoute, "POST", {
      idempotency: "url-retry",
    });
    assert.equal(urlRetry.status, 202);
    assert.equal(urlRetry.data.attempt_count, 2);
    assert.equal(urlRetry.data.retry_of, rejectedUrl.id);
    assert.equal(
      (await call(retryRoute, "POST", { idempotency: "url-retry" })).data.id,
      urlRetry.data.id,
    );
    assert.equal(
      (await call(retryRoute, "POST", { idempotency: "duplicate-url-retry" }))
        .status,
      400,
    );
    assert.equal((await waitForJob(urlRetry.data.id)).status, "failed");
    const fixedPayload = {
      title: "Recovered",
      kind: "paste",
      text: "Corrected input after URL failure",
      idempotency: "corrected-input",
      retryOf: urlRetry.data.id,
    };
    const fixed = await call(
      "/notebooks/" + n + "/import",
      "POST",
      fixedPayload,
    );
    assert.equal(fixed.data.attempt_count, 3);
    assert.equal(
      (await call("/notebooks/" + n + "/import", "POST", fixedPayload)).data.id,
      fixed.data.id,
    );
    const recovered = await waitForJob(fixed.data.id);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.retry_of, urlRetry.data.id);
    assert.equal(recovered.input_metadata.includes(fixedPayload.text), false);
    assert.equal(
      view.jobs.filter((j: any) => j.retry_of === urlRetry.data.id).length,
      1,
    );
    assert.equal(
      (
        await call(
          "/notebooks/" + n + "/jobs/" + fixed.data.id + "/retry",
          "POST",
          { idempotency: "repeat-success" },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          `/notebooks/${seedNotebook}/sources/${richSource.id}?purge=true`,
          "DELETE",
        )
      ).status,
      200,
    );
    const purgedRich = (
      await call(`/notebooks/${seedNotebook}`)
    ).data.artifacts.find((a: any) => a.id === createdRich.data.id);
    assert.equal(purgedRich.referenceAvailability[richPassage.id], false);
    assert.equal(purgedRich.referencesUnavailable, true);
    assert.equal(
      (
        await call(richRoute + "/promote", "POST", {
          revisionId: purgedRich.revision_id,
        })
      ).status,
      400,
    );
    const retainedExport = await fetch(`${base}/api${richRoute}/export`, {
      headers: { Cookie: cookie },
    });
    assert.match(await retainedExport.text(), /Evidence unavailable/);
    const retainedHtml = await fetch(
        `${base}/api${richRoute}/export?format=html`,
        { headers: { Cookie: cookie } },
      ),
      retainedHtmlText = await retainedHtml.text();
    assert.equal(retainedHtml.status, 200);
    assert.match(retainedHtmlText, /Evidence unavailable/);
    assert.doesNotMatch(retainedHtmlText, /class="evidence-quote"/);
    assert.equal(
      (
        await fetch(
          `${base}/api/notebooks/${seedNotebook}/artifacts/${quizArtifact.id}/export?format=html`,
          { headers: { Cookie: cookie } },
        )
      ).status,
      400,
    );
    const captionNotebook = (
      await call("/notebooks", "POST", { title: "Caption HTTP checks" })
    ).data.id;
    const settledCaption = async (id: string) => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const view = (await call(`/notebooks/${captionNotebook}`)).data;
        const job = view.jobs.find((item: any) => item.id === id);
        if (
          job &&
          ["completed", "failed", "duplicate", "cancelled"].includes(job.status)
        )
          return { view, job };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw Error("Caption import did not settle.");
    };
    for (const [kind, text] of [
      ["srt", srtCaptions],
      ["vtt", vttCaptions],
    ]) {
      const posted = await call(
        `/notebooks/${captionNotebook}/import`,
        "POST",
        {
          title: `Captions.${kind}`,
          kind,
          base64: Buffer.from(text).toString("base64"),
          idempotency: "caption-http-" + kind,
        },
      );
      assert.equal(posted.status, 202);
      const settled = await settledCaption(posted.data.id);
      assert.equal(settled.job.status, "completed");
      const source = settled.view.sources.find(
        (s: any) => s.id === settled.job.source_id,
      );
      const viewer = (
        await call(`/notebooks/${captionNotebook}/sources/${source.id}`)
      ).data;
      assert.match(viewer.passages[0].locator, /00:00:01.250/);
      assert.ok(viewer.passages[0].text.includes("Do not approve"));
      assert.equal(viewer.revisions[0].extractor, EXTRACTION_VERSION);
      const original = await fetch(
        `${base}/api/notebooks/${captionNotebook}/sources/${source.id}/original`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(original.status, 200);
      assert.ok(
        original.headers.get("content-disposition")?.endsWith(`.${kind}\"`),
      );
      assert.deepEqual(
        Buffer.from(await original.arrayBuffer()),
        Buffer.from(text),
      );
      assert.equal(
        (await call(`/notebooks/${seedNotebook}/sources/${source.id}`)).status,
        400,
      );
    }
    const badCaption = await call(
      `/notebooks/${captionNotebook}/import`,
      "POST",
      {
        title: "Bad captions",
        kind: "srt",
        text: "1\ninvalid timing\nNo partial source",
        idempotency: "bad-caption-http",
      },
    );
    const failedCaption = await settledCaption(badCaption.data.id);
    assert.equal(failedCaption.job.status, "failed");
    assert.equal(failedCaption.view.sources.length, 2);
    const correctedCaption = await call(
      `/notebooks/${captionNotebook}/import`,
      "POST",
      {
        title: "Corrected captions",
        kind: "srt",
        text: srtCaptions,
        idempotency: "corrected-caption-http",
        retryOf: badCaption.data.id,
      },
    );
    assert.equal(correctedCaption.status, 202);
    assert.equal(
      (await settledCaption(correctedCaption.data.id)).job.status,
      "duplicate",
    );
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
