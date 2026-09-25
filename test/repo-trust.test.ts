/**
 * What an untrusted REPOSITORY can do to you.
 *
 * The desktop app changes who opens the code: on one developer's machine every
 * repository is one they chose, and the interesting attacks need a hostile
 * renderer. Distributed to strangers, the repository itself becomes untrusted
 * input — and a repository is allowed to carry files that change how the agent
 * behaves before you have read a line of it.
 *
 * These are the three fixes that shipped for that, from the release-scoped
 * review on 2026-08-07.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALWAYS_APPROVE_NOTICE_KEY,
  alwaysApproveSource,
  configForcesAlwaysApprove,
} from "../src/grok-config";
import { sessionScopedRoots } from "../src/auth-roots";
import { resolveTreePath, writeTreeFile } from "../src/desktop/file-tree";

// Platform-injected fs stubs so both path worlds are testable from either OS —
// the whole reason the bug below survived is that nothing exercised POSIX.
const stubFs = (sep: "/" | "\\") => ({
  realpathSync: (p: string) => p,
  existsSync: () => true,
  statSync: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }) as never,
  lstatSync: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }) as never,
  readdirSync: () => [] as never,
  sep,
});
const posixFs = stubFs("/") as never;
const win32Fs = stubFs("\\") as never;

const sidebarSrc = () =>
  fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");

const ALWAYS = '[ui]\npermission_mode = "always-approve"\n';
const ASK = '[ui]\npermission_mode = "ask"\n';

describe("who turned auto-approve on", () => {
  it("names the project when the project file forces it", () => {
    // The dangerous case: this file ships inside a repository, so cloning
    // someone's code is enough to carry it.
    expect(alwaysApproveSource({ project: ALWAYS })).toBe("project");
  });

  it("names the project even when the user's own setting disagrees", () => {
    // Project overrides global in grok, so a repo can override a deliberate
    // "ask me" with "never ask". That is the whole reason consent exists.
    expect(alwaysApproveSource({ project: ALWAYS, global: ASK })).toBe("project");
  });

  it("names global when it is the user's own standing choice", () => {
    // Not dangerous, and must stay silent — the user set this themselves in
    // their own TUI. Prompting here would train them to click through.
    expect(alwaysApproveSource({ global: ALWAYS })).toBe("global");
  });

  it("does not fall back to global when the project explicitly says otherwise", () => {
    // Precedence, not an OR: a project saying "ask" wins over a global
    // "always-approve", so there is nothing to consent to.
    expect(alwaysApproveSource({ project: ASK, global: ALWAYS })).toBeUndefined();
  });

  it("is undefined when nothing forces it", () => {
    expect(alwaysApproveSource({})).toBeUndefined();
    expect(alwaysApproveSource({ project: "[ui]\n", global: "" })).toBeUndefined();
  });

  it("still answers the old boolean question identically", () => {
    // configForcesAlwaysApprove is the mode indicator's input and must not have
    // changed meaning — the UI would start lying about "Auto accept".
    for (const input of [
      { project: ALWAYS },
      { project: ALWAYS, global: ASK },
      { global: ALWAYS },
      { project: ASK, global: ALWAYS },
      {},
    ]) {
      expect(configForcesAlwaysApprove(input)).toBe(alwaysApproveSource(input) !== undefined);
    }
  });
});

describe("consent gate wiring", () => {
  it("asks before the session starts, and declining starts nothing", () => {
    const src = sidebarSrc();
    const start = src.indexOf("private async startSessionBody(");
    expect(start).toBeGreaterThan(0);
    // Wide enough to reach ++session.gen past startSession's early-return
    // blocks as they grow; the assertions below still pin the ordering, the
    // slice only bounds the search.
    // Search bound only (see below) — and one that has to clear `++session.gen`
    // at ~6400 chars, which 6000 stopped doing when the open clock grew the
    // prologue. Too small a bound does not weaken this test, it BREAKS it: the
    // mutation reads as absent and the ordering assertion has nothing to compare.
    const body = src.slice(start, start + 9000);
    const asked = body.indexOf("confirmRepoForcedAutoApprove");
    expect(asked).toBeGreaterThan(0);
    // Before ++session.gen — nothing is mutated yet, so declining is a clean
    // no-op rather than a half-started session left behind.
    const mutates = body.indexOf("++session.gen");
    expect(mutates).toBeGreaterThan(0);
    expect(asked).toBeLessThan(mutates);
  });

  it("only prompts for a project-supplied config", () => {
    const src = sidebarSrc();
    const start = src.indexOf("private async confirmRepoForcedAutoApprove(");
    const body = src.slice(start, src.indexOf("private configForcesAutoApprove", start));
    expect(body).toContain('!== "project"');
    // Asked once per root, not once per session start — a project with several
    // conversations would otherwise prompt on every one of them.
    expect(body).toContain("autoApproveConsented");
  });
});

describe("global always-approve notice", () => {
  it("survives a process restart, not just the current activation", () => {
    // Desktop turns showInformationMessage into a blocking dialog, so "once
    // per activation" was every app launch. The flag has to live in the
    // host memento or the same person is trained to click Cancel.
    const src = sidebarSrc();
    const start = src.indexOf("private noticeAlwaysApproveOnce(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("private setPlanActive", start));
    expect(body).toContain("ALWAYS_APPROVE_NOTICE_KEY");
    expect(body).toContain("this.state.get");
    expect(body).toContain("this.state.update");
    expect(body).toContain("shouldShowAlwaysApproveNotice");
    expect(ALWAYS_APPROVE_NOTICE_KEY).toBe("grok.alwaysApproveNoticeShown");
  });
});

describe("desktop file roots are session-scoped", () => {
  const A = path.resolve("/work/repo-a");
  const B = path.resolve("/work/repo-b");
  // Both repos are open. That is the whole point: openness is not the question.
  const bothOpen = (cwd: string) => [A, B].some((r) => path.resolve(cwd) === r);

  it("a session in repo A cannot reach repo B, even though B is open", () => {
    const roots = sessionScopedRoots({ sessionCwd: A, isAuthorized: bothOpen, platform: "linux" });
    expect(roots).toEqual([A]);
    expect(roots).not.toContain(B);
  });

  it("carries the session's own worktree, which is not separately open", () => {
    const wt = path.resolve("/work/repo-a/.worktrees/feature");
    const roots = sessionScopedRoots({
      sessionCwd: A,
      worktreePath: wt,
      worktreeSourceRoot: A,
      isAuthorized: bothOpen,
      platform: "linux",
    });
    expect(roots).toContain(wt);
    expect(roots).toContain(A);
    expect(roots).not.toContain(B);
    // Deduped — A arrives twice, as cwd and as the worktree's source.
    expect(roots.filter((r) => r === A)).toHaveLength(1);
  });

  it("refuses a session cwd the host does not have open", () => {
    // A historical catalog cwd, or a folder that has since been closed.
    const closed = path.resolve("/work/closed");
    expect(sessionScopedRoots({ sessionCwd: closed, isAuthorized: bothOpen, platform: "linux" })).toEqual([]);
  });

  it("falls back to the active folder only when the session has no cwd", () => {
    expect(sessionScopedRoots({ activeRoot: A, isAuthorized: bothOpen, platform: "linux" })).toEqual([A]);
    // ...and the fallback is gated too.
    expect(
      sessionScopedRoots({ activeRoot: path.resolve("/nope"), isAuthorized: bothOpen, platform: "linux" }),
    ).toEqual([]);
  });

  it("dedupes case-insensitively on Windows and not elsewhere", () => {
    const win = sessionScopedRoots({
      sessionCwd: "C:/Work/Repo",
      worktreePath: "c:/work/repo",
      isAuthorized: () => true,
      platform: "win32",
    });
    expect(win).toHaveLength(1);
    const nix = sessionScopedRoots({
      sessionCwd: "/work/Repo",
      worktreePath: "/work/repo",
      isAuthorized: () => true,
      platform: "linux",
    });
    expect(nix).toHaveLength(2);
  });

  it("uses the asking session's cwd, not every open folder", () => {
    const src = sidebarSrc();
    const start = src.indexOf("desktopAuthRoots(session");
    const body = src.slice(start, src.indexOf("async addProjectFolder", start));
    expect(body).toContain("this.sessionCwd(session)");
    // The old shape: iterate the whole trusted set and return all of it. That
    // let a message from repo A reach a file in repo B.
    expect(body).not.toContain("for (const c of this.localTrustedSessionCwds");
    // Being open is still necessary — just no longer sufficient.
    expect(body).toContain("isAuthorizedCwd");
  });
});

describe("host confirmation on the messages that run something", () => {
  it("guards the execute-class handlers", () => {
    const src = sidebarSrc();
    for (const handler of ['case "runInstallCmd"', 'case "runMuseInstallCmd"', 'case "updateGrok"']) {
      const start = src.indexOf(handler);
      expect(start).toBeGreaterThan(0);
      const body = src.slice(start, start + 700);
      expect(body).toContain("confirmHostExecute");
    }
  });

  it("uses a host dialog the renderer cannot draw or dismiss", () => {
    const src = sidebarSrc();
    const start = src.indexOf("private async confirmHostExecute(");
    const body = src.slice(start, start + 700);
    // An in-webview confirm would be worthless here: the thing we are guarding
    // against is code running in the webview.
    expect(body).toContain("showWarningMessage");
    expect(body).toContain("modal: true");
  });
});

describe("POSIX absolute paths are recognised as absolute", () => {
  // Caught by CI, invisible on Windows, and invisible to every existing test
  // because they all ran on the developer's own platform. The leading slash was
  // stripped before the absolute-path check, so on macOS and Linux "/etc/passwd"
  // became "etc/passwd" and resolved against the workspace root instead. Not an
  // escape — it landed inside the root — but openFile is documented to accept
  // absolute paths, so on macOS opening a file by absolute path opened nothing.
  const root = "/home/u/proj";

  it("refuses an absolute path outside the workspace", () => {
    const r = resolveTreePath(root, "/etc/passwd", "linux", posixFs);
    expect(r.ok).toBe(false);
  });

  it("does not quietly reinterpret it as workspace-relative", () => {
    const r = resolveTreePath(root, "/etc/passwd", "linux", posixFs);
    // The bug's signature: ok, with the path rewritten under the root.
    expect(r.ok && r.absPath).not.toBe("/home/u/proj/etc/passwd");
  });

  it("still accepts an absolute path that IS inside the workspace", () => {
    const r = resolveTreePath(root, "/home/u/proj/src/main.ts", "linux", posixFs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relPath).toBe("src/main.ts");
  });

  it("leaves Windows alone — a leading slash there is workspace-relative", () => {
    // Windows absolutes carry a drive letter or a UNC prefix, both checked
    // separately, and callers do pass "/src/x" meaning relative-to-root.
    const r = resolveTreePath("C:\proj", "/src/main.ts", "win32", win32Fs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relPath).toBe("src/main.ts");
  });
});

describe("a save cannot follow the workspace to another project", () => {
  // Found by review, hours before release. A tab left open on repo A and saved
  // after the active folder moved to repo B wrote A's text into B's same-named
  // file: the save carried only a relative path and the host resolved it
  // against whatever root was current. The mtime stamp caught the common case
  // and then offered Overwrite, which completed the loss.
  const ipcSrc = () =>
    fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "file-tree-ipc.ts"), "utf8");

  it("the save handler refuses when the read-time path no longer resolves there", () => {
    const src = ipcSrc();
    const start = src.indexOf("ipcMain.handle(CH_SAVE");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("const win = opts.getMainWindow()", start));
    // The handler's job is to PASS the binding; the comparison itself lives in
    // writeTreeFile, beside the stamp check, where it is decidable from
    // arguments and cannot be skipped by a caller. Behavioural coverage of the
    // comparison is below.
    expect(body).toContain("request.absPath");
    expect(body).toContain("expectedAbsPath");
  });

  it("the shared panel sends the path it read on normal and overwrite saves", () => {
    // Overwrite is the dangerous one: it is the branch the user reaches AFTER
    // being told the file changed, so it must carry the binding too.
    const panel = fs.readFileSync(
      path.join(__dirname, "..", "src", "desktop", "file-tree-panel.ts"),
      "utf8",
    );
    const saves = panel.match(/api\.save\(\{[^}]*\}/g) || [];
    // One adapter method serves every save path; Overwrite refreshes its stamp
    // in the shared component and then deliberately calls that same method.
    expect(saves).toHaveLength(1);
    expect(saves[0]).toContain("absPath");
    const shared = fs.readFileSync(
      path.join(__dirname, "..", "media", "file-panel.js"),
      "utf8",
    );
    expect(shared).toContain("fresh.absPath !== tab.expectedAbsPath");
    expect(shared).toContain("return saveTab(tab)");
  });
});

describe("writeTreeFile refuses a path that has moved projects", () => {
  // Behavioural, not structural: the earlier version of this test asserted on
  // the source text and survived replacing the whole guard with `if (false)`.
  const stamp = { mtimeMs: 1, size: 1 };
  const opts = {
    platform: "linux" as NodeJS.Platform,
    isExecutableOpenTarget: () => false,
    readFileSync: () => Buffer.from("x"),
    writeFileSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {},
    pathFs: {
      realpathSync: (p: string) => p,
      existsSync: () => true,
      statSync: () => ({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        mtimeMs: 1,
        size: 1,
        mode: 0o644,
      }),
      lstatSync: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }),
      readdirSync: () => [],
      sep: "/",
    },
  } as never;

  it("refuses when the same relPath now resolves under a different root", () => {
    // The tab was read at /work/repo-a/README.md; the active folder has since
    // moved to repo-b, where README.md is a completely different file.
    const r = writeTreeFile("/work/repo-b", "README.md", "A's text", stamp, {
      ...(opts as object),
      expectedAbsPath: "/work/repo-a/README.md",
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("workspace changed");
  });

  it("allows the write when the path still means the same file", () => {
    const r = writeTreeFile("/work/repo-a", "README.md", "A's text", stamp, {
      ...(opts as object),
      expectedAbsPath: "/work/repo-a/README.md",
    } as never);
    // Reaches past the binding check (whatever else it then decides).
    if (!r.ok) expect(r.reason).not.toBe("workspace changed");
  });
});
