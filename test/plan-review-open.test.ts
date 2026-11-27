import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSafePlanReviewFileName,
  isSafeRelativePlanReviewLink,
  isTrustedPlanReviewPath,
  planReviewSessionDirectoryName,
} from "../src/plan-review";
import {
  authorizeDesktopWebviewMsg,
  authorizeOpenFile,
  desktopAuthRoots,
  resolveAuthorizedFileForOpen,
} from "../src/desktop/desktop-policy";

describe("plan-review path fence", () => {
  it("accepts only a session segment and one Markdown file", () => {
    expect(isSafeRelativePlanReviewLink("session-id/no-op.md")).toBe(true);
    expect(isSafeRelativePlanReviewLink("session-id/NO-OP.MD")).toBe(true);
    expect(isSafeRelativePlanReviewLink("session-id/sub/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("../session-id/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/../no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/no-op.txt")).toBe(false);
    expect(isSafeRelativePlanReviewLink("C:\\outside\\no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("\\\\server\\share\\no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("file:///outside/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/no-op.md\0")).toBe(false);
  });

  it("accepts only one Markdown file below a conversation-scoped root", () => {
    expect(isSafePlanReviewFileName("no-op.md")).toBe(true);
    expect(isSafePlanReviewFileName("NO-OP.MD")).toBe(true);
    expect(isSafePlanReviewFileName("session-id/no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("../no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("no-op.txt")).toBe(false);
    expect(isSafePlanReviewFileName("C:\\outside\\no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("file:no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("no-op.md\0")).toBe(false);
  });

  it("derives the same bounded conversation directory segment used by snapshots", () => {
    expect(planReviewSessionDirectoryName("Conversation A / ..")).toBe("conversation-a-..");
    expect(planReviewSessionDirectoryName("x".repeat(100))).toHaveLength(80);
  });

  it("requires existence before and after canonicalisation", () => {
    const root = path.join(path.resolve("."), "plan-review-root", "session-id");
    const candidate = path.join(root, "no-op.md");
    const existing = new Set([candidate]);
    const realpath = (p: string) => path.resolve(p);

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(true);
    expect(
      isTrustedPlanReviewPath(path.join(root, "..", "no-op.md"), root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);

    existing.clear();
    existing.add(candidate);
    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath: (p) => path.join(path.dirname(root), "canonical-missing.md"),
      }),
    ).toBe(false);
  });

  it("refuses a plan file symlink that leaves plan-reviews", () => {
    const root = path.join(path.resolve("."), "plan-review-root", "session-id");
    const candidate = path.join(root, "no-op.md");
    const outside = path.join(path.dirname(path.dirname(root)), "secret.md");
    const existing = new Set([candidate, outside]);
    const realpath = (p: string) => (path.resolve(p) === path.resolve(candidate) ? outside : path.resolve(p));

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a relocated plan-reviews directory", () => {
    const storage = path.join(path.resolve("."), "global-storage");
    const reviews = path.join(storage, "plan-reviews");
    const root = path.join(reviews, "session-id");
    const candidate = path.join(root, "no-op.md");
    const relocated = path.join(path.dirname(storage), "other-storage", "plan-reviews");
    const existing = new Set([candidate, path.join(relocated, "session-id", "no-op.md")]);
    const realpath = (p: string) => {
      const resolved = path.resolve(p);
      return resolved === path.resolve(reviews) || resolved.startsWith(path.resolve(reviews) + path.sep)
        ? path.join(relocated, path.relative(reviews, resolved))
        : resolved;
    };

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a session-directory link to a sibling session", () => {
    const reviews = path.join(path.resolve("."), "plan-review-root");
    const root = path.join(reviews, "session-a");
    const candidate = path.join(root, "no-op.md");
    const sibling = path.join(reviews, "session-b", "no-op.md");
    const existing = new Set([candidate, sibling]);
    const realpath = (p: string) => {
      const resolved = path.resolve(p);
      const session = root;
      return resolved === session || resolved.startsWith(session + path.sep)
        ? path.join(reviews, "session-b", path.relative(session, resolved))
        : resolved;
    };

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a file link to another file even within the same session", () => {
    const root = path.join(path.resolve("."), "plan-review-root", "session-id");
    const candidate = path.join(root, "no-op.md");
    const other = path.join(root, "other.md");
    const existing = new Set([candidate, other]);
    const realpath = (p: string) => path.resolve(p) === path.resolve(candidate) ? other : path.resolve(p);

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("allows only the focused conversation's snapshot without widening project roots", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plan-open-"));
    const repo = path.join(base, "repo");
    const planReviewsRoot = path.join(base, "globalStorage", "plan-reviews");
    const focusedRoot = path.join(planReviewsRoot, "focused-session");
    const plan = path.join(focusedRoot, "no-op-plan.md");
    const otherPlan = path.join(planReviewsRoot, "other-session", "secret-plan.md");
    try {
      fs.mkdirSync(path.dirname(plan), { recursive: true });
      fs.mkdirSync(path.dirname(otherPlan), { recursive: true });
      fs.mkdirSync(repo, { recursive: true });
      fs.writeFileSync(plan, "# no-op\n");
      fs.writeFileSync(otherPlan, "# another conversation\n");
      const ctx = { workspaceRoot: repo, planReviewSessionRoot: focusedRoot };

      expect(desktopAuthRoots(ctx)).toEqual([path.resolve(repo)]);
      expect(authorizeOpenFile(plan, ctx)).toEqual({ ok: true, absPath: path.resolve(plan) });
      expect(resolveAuthorizedFileForOpen(plan, ctx)).toEqual({
        ok: true,
        absPath: path.resolve(plan),
      });
      expect(authorizeDesktopWebviewMsg({ type: "openFile", path: plan }, ctx)).toEqual({
        msg: { type: "openFile", path: plan },
      });
      expect(authorizeOpenFile(otherPlan, ctx).ok).toBe(false);
      expect(resolveAuthorizedFileForOpen(otherPlan, ctx).ok).toBe(false);
      expect(authorizeDesktopWebviewMsg({ type: "openFile", path: otherPlan }, ctx)).toEqual({
        type: "openFile",
        refused: true,
        reason: "path escapes authorized roots",
      });

      const outside = path.join(base, "globalStorage", "other.md");
      fs.writeFileSync(outside, "not a plan review");
      expect(authorizeOpenFile(outside, ctx).ok).toBe(false);
      expect(resolveAuthorizedFileForOpen(outside, ctx).ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("opens a Claude plan from its own plans directory, and nothing else there", () => {
    // Claude writes a plan under <home>/.claude/plans and then cites the path,
    // so refusing it left the link the agent had just handed the user dead.
    // Same narrow rule as the review root: a direct .md child, and never a
    // general read root.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-"));
    const plansRoot = path.join(base, ".claude", "plans");
    const repo = path.join(base, "repo");
    const plan = path.join(plansRoot, "in-the-plan-mode-happy-cook.md");
    const nested = path.join(plansRoot, "deeper", "nested-plan.md");
    const notMarkdown = path.join(plansRoot, "notes.txt");
    try {
      fs.mkdirSync(path.dirname(nested), { recursive: true });
      fs.mkdirSync(repo, { recursive: true });
      fs.writeFileSync(plan, "# plan\n");
      fs.writeFileSync(nested, "# nested\n");
      fs.writeFileSync(notMarkdown, "not markdown");
      const ctx = { workspaceRoot: repo, claudePlansRoot: plansRoot };

      expect(authorizeOpenFile(plan, ctx)).toEqual({ ok: true, absPath: path.resolve(plan) });
      // The directory is a provenance class, not an auth root.
      expect(desktopAuthRoots(ctx)).toEqual([path.resolve(repo)]);
      expect(authorizeOpenFile(nested, ctx).ok).toBe(false);
      expect(authorizeOpenFile(notMarkdown, ctx).ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("wires the focused review root lazily from the sidebar", () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const main = fs.readFileSync(path.join(repoRoot, "src", "desktop", "main.ts"), "utf8");
    const sidebar = fs.readFileSync(path.join(repoRoot, "src", "sidebar.ts"), "utf8");
    expect(main).toContain("get planReviewSessionRoot()");
    expect(main).toContain("sidebar!.desktopPlanReviewSessionRoot(session)");
    expect(main).not.toContain('planReviewsRoot: path.join(globalStorageDir, "plan-reviews")');
    expect(sidebar).toContain("desktopPlanReviewSessionRoot(session: Session = this.focused)");
    expect(sidebar).toContain("planReviewSessionDirectoryName(sessionId)");
  });
});
