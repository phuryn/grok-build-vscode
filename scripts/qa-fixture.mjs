// The grok-qa fixture: a project tree AND a session store, both deterministic.
//
// Every end-to-end check we had fabricated its own throwaway workspace, which
// meant two things. Screenshots were not comparable run to run — the frames
// literally said `grok-screens-ws-7TWbru` in the project row — and no check
// ever saw a rail with more than one conversation in it, so anything that only
// goes wrong with accumulated history (ordering, paging, pins, archives) was
// invisible to all of them.
//
// This builds the same store every time: fixed ids, fixed timestamps, fixed
// bytes. `GROK_HOME` is a supported override (`resolveGrokHome`), so pointing a
// host at one of these needs no product change.
//
// Deliberately NOT a committed directory: a session store is mtimes as much as
// it is files, and git does not carry mtimes. Generating it is what makes the
// ordering reproducible.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Fixed clock: 09:00 UTC yesterday. Fixed within a day so the screenshots stay
 * comparable, and recent because history older than 30 days is not listed
 * (HISTORY_HORIZON_MS, 3825696). A fixed date (it was 2026-01-15) fell out of
 * that window and the rail came up with no fixture history at all.
 */
const T0 = (() => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 9, 0, 0);
})();
const minutes = (n) => T0 + n * 60_000;

export const QA_PROJECT_NAME = "grok-qa";

/** The tree the file panel browses. Small, but with every shape it renders. */
const PROJECT_FILES = {
  "README.md": [
    "# grok-qa",
    "",
    "A fixed project used by the end-to-end checks. Everything here is chosen to",
    "exercise a renderer, not to be useful.",
    "",
    "## What is in here",
    "",
    "- `src/` and `docs/` so the tree has folders to expand",
    "- a JSON file, for the other editable kind",
    "- a binary, which the panel must refuse rather than preview",
    "",
  ].join("\n"),
  "package.json": JSON.stringify({ name: "grok-qa", version: "1.0.0", private: true }, null, 2) + "\n",
  "src/index.ts": "export function greet(who: string): string {\n  return `hello, ${who}`;\n}\n",
  "src/util.ts": "export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n",
  "docs/notes.md": "# Notes\n\nA second Markdown file, so Preview is reachable from more than one row.\n",
};

/** Conversations, newest last. Titles are recognisable in a screenshot. */
const SESSIONS = [
  { id: "0000qa01-0000-4000-8000-00000000cafe", title: "Set up the QA fixture", messages: 12, at: minutes(0) },
  { id: "0000qa02-0000-4000-8000-00000000cafe", title: "Rename a conversation", messages: 4, at: minutes(30) },
  { id: "0000qa03-0000-4000-8000-00000000cafe", title: "Browse project files", messages: 22, at: minutes(75) },
  { id: "0000qa04-0000-4000-8000-00000000cafe", title: "Edit a file from the panel", messages: 7, at: minutes(120) },
];

const require = createRequire(import.meta.url);

function write(file, body, at) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (at) fs.utimesSync(file, new Date(at), new Date(at));
}

/**
 * Build the fixture. Returns the paths a host needs.
 *
 * @param root where to build; defaults to a fresh temp directory
 * @param {(cwd: string) => string} encodeCatalogLeaf the product encoder. Unit tests can pass the source import.
 * @param {string[]} extraTitles more conversations for grid captures
 */
export function buildQaFixture(
  root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-qa-")),
  encodeCatalogLeaf = require("../out/sessions.js").encodeSessionCatalogLeaf,
  extraTitles = [],
) {
  const project = path.join(root, QA_PROJECT_NAME);
  const grokHome = path.join(root, "grok-home");

  for (const [rel, body] of Object.entries(PROJECT_FILES)) {
    write(path.join(project, rel), body);
  }
  // Refused by the preview classifier — the panel must say so, not render it.
  write(path.join(project, "payload.bin"), Buffer.from([0, 1, 2, 0, 9, 0]));

  const sessionsDir = path.join(grokHome, "sessions", encodeCatalogLeaf(project));
  const sessions = [...SESSIONS, ...extraTitles.map((title, index) => ({
    id: `0000qa${String(SESSIONS.length + index + 1).padStart(2, "0")}-0000-4000-8000-00000000cafe`,
    title, messages: 4, at: minutes(150 + index * 30),
  }))];
  for (const session of sessions) {
    const dir = path.join(sessionsDir, session.id);
    write(path.join(dir, "summary.json"), JSON.stringify({
      info: { id: session.id, cwd: project },
      session_summary: session.title,
      generated_title: session.title,
      created_at: new Date(T0).toISOString(),
      updated_at: new Date(session.at).toISOString(),
      num_messages: session.messages,
      current_model_id: "grok-build",
    }, null, 2) + "\n", session.at);
    // The transcript's mtime is what the rail orders by — `updated_at` moves
    // when a conversation is merely opened, which is why ordering stopped
    // trusting it. Stamped explicitly so the order is a property of the
    // fixture rather than of the order the files happened to be written in.
    const transcript = [
      { type: "user", text: session.title },
      { type: "agent", text: "Acknowledged." },
    ];
    write(path.join(dir, "events.jsonl"), transcript.map(message => JSON.stringify(message)).join("\n") + "\n", session.at);
    // The rail fixture alone is not replayable. The fake ACP CLI reads this
    // file on session/load and streams its messages before acknowledging the id.
    write(path.join(dir, "chat_history.jsonl"), transcript.map(({ type, text }) =>
      JSON.stringify({ type, content: text })).join("\n") + "\n", session.at);
  }

  return {
    root,
    project,
    grokHome,
    projectName: QA_PROJECT_NAME,
    sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
    /** Newest first, which is the order the rail should show. */
    expectedOrder: [...sessions].sort((a, b) => b.at - a.at).map((s) => s.title),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// `pathToFileURL`, not string surgery: on Windows a drive path becomes
// `file:///C:/…` (three slashes) and a hand-built `file://${argv[1]}` never
// matches, so the CLI branch silently did nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const built = buildQaFixture(process.argv[2]);
  console.log(JSON.stringify({ project: built.project, grokHome: built.grokHome, order: built.expectedOrder }, null, 2));
}
