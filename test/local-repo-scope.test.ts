/**
 * Guards for "VS Code history follows the rail's project selection".
 *
 * History used to be pinned to the open workspace folder on VS Code, and the
 * reason was a good one: the repo switcher was hidden there, so a selection the
 * local user could not see must not decide where Grok reads history or writes
 * files — a phone that switched repos hours ago would have been aiming the
 * desk's New Session at another checkout.
 *
 * The projects rail is that switcher, so the premise is gone and the rule now
 * produces the wrong answer instead: a conversation from project B on screen
 * with A's history beside it. What makes the new rule safe is NOT that the old
 * worry was wrong — it is that a remote's selection provably cannot reach
 * `selectedRepoCwd`. Each assertion below is one leg of that argument, and each
 * fails on exactly the edit that would remove it.
 *
 * Source-level: `GrokSidebar` needs a whole fake Host to construct, and these
 * are one-line invariants rather than behaviours with interesting inputs.
 * `sidebar-portable.test.ts` sets the precedent for the technique.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { repoScopeFor } from "../src/remote-policy";
import { relativePathWithin } from "../src/sessions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = fs
  .readFileSync(path.join(root, "src", "sidebar.ts"), "utf8")
  .replace(/\r\n/g, "\n");

/** Body of a method, sliced from its declaration to the first dedented `}`. */
function methodBody(name: string): string {
  const at = sidebar.indexOf(name);
  expect(at, `${name} must still exist`).toBeGreaterThan(-1);
  const end = sidebar.indexOf("\n  }\n", at);
  expect(end).toBeGreaterThan(at);
  return sidebar.slice(at, end);
}

describe("local repo scope", () => {
  it("scopes local history and New Session to the selection, not the open folder", () => {
    const body = methodBody("private historyCwdFor(");
    expect(body).toMatch(/origin === "local"/);
    expect(body).toMatch(/this\.selectedHistoryCwd\(\)/);
  });

  it("leaves remote scope to repoScopeFor, where per-tab isolation lives", () => {
    expect(methodBody("private historyCwdFor(")).toMatch(/repoScopeFor\(origin,/);
    // The pure rule itself is unchanged: a remote gets its own tab's cwd and
    // falls back to the workspace root, never to the LOCAL user's selection.
    expect(repoScopeFor("remote", { selectedCwd: "/b", workspaceRoot: "/a" })).toBe("/b");
    expect(repoScopeFor("remote", { selectedCwd: "", workspaceRoot: "/a" })).toBe("/a");
  });

  it("routes a remote selectRepo away from the local selection", () => {
    // The whole safety argument. If this ever falls through to `selectRepo`, a
    // phone starts writing `selectedRepoCwd` and the rule above becomes the
    // hole the original comment warned about.
    const at = sidebar.indexOf('case "selectRepo":');
    expect(at).toBeGreaterThan(-1);
    const arm = sidebar.slice(at, sidebar.indexOf("break;", at));
    expect(arm).toMatch(/origin === "remote" && clientId/);
    expect(arm).toMatch(/this\.selectRemoteRepo\(clientId, msg\.cwd\)/);
  });

  it("keeps the openSession selection-follow off hosts that own a workspace", () => {
    // Desktop's selection and its ACTIVE FOLDER are one thing — file tree, New
    // Session and rail all read it — so moving the selection without switching
    // the folder would split them. Opening a conversation is not a request to
    // change which project you are in.
    const body = methodBody("// The history list follows the conversation the LOCAL user just opened.");
    // `return true` since openSession began reporting its outcome: the
    // conversation IS open on this path, and only the VS Code half of the
    // switch is skipped. Reading it as a failure would have made a caller
    // mint a blank conversation over a perfectly good one.
    expect(body).toMatch(/if \(this\.host\.canSwitchWorkspaceFolder\) return;/);
    expect(body).toMatch(/this\.selectedRepoCwd = openedIn\.cwd;/);
  });

  it("offers Add project on the local frame only", () => {
    // The picker is a native dialog on the desk. A phone cannot see or answer
    // it, so the remote `repos` builder must not carry the flag.
    expect(methodBody("private postRepoCatalog()")).toMatch(/canAddProject: this\.canAddProjectFolder\(\)/);
    expect(methodBody("private buildRemoteReposMsg(")).not.toMatch(/canAddProject/);
  });

  it("does not read the projects-panel setting on a host that owns its folders", () => {
    // Desktop already lists open folders. Reading the VS Code setting there
    // would attach a second, different filter to a rail that does not use it.
    const body = methodBody("private projectsPanelWorkspaceOnly()");
    const guard = body.indexOf("if (this.host.canSwitchWorkspaceFolder) return false;");
    const read = body.indexOf('getConfiguration("grok")');
    expect(guard).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(guard);
  });

  it("limits the local repos frame without shrinking the catalog", () => {
    // The entries are the trust list. Filtering them would close every other
    // project for the phone. The rail is what declines to paint some rows,
    // and only when this window actually has a folder open.
    const body = methodBody("private postRepoCatalog()");
    expect(body).toMatch(/entries: localEntries,/);
    expect(body).not.toMatch(/localEntries\.filter/);
    expect(body).toMatch(
      /const openFolders = this\.projectsPanelWorkspaceOnly\(\) \? this\.openWorkspaceFolders\(\) : \[\];/,
    );
    expect(body).toMatch(
      /\.\.\.\(openFolders\.length\s*\?\s*\{ workspaceFolders: openFolders, workspaceOnly: true as const \}/,
    );
    expect(methodBody("private buildRemoteReposMsg(")).not.toMatch(/workspaceOnly/);
  });

  it("writes the projects-panel setting where it is already set, and republishes the rail", () => {
    const at = sidebar.indexOf('case "setProjectsWorkspaceOnly":');
    expect(at).toBeGreaterThan(-1);
    const arm = sidebar.slice(at, sidebar.indexOf("break;", at));
    expect(arm).toMatch(/configWriteTarget\(cfg\.inspect\("projects\.workspaceOnly"\)\)/);
    expect(arm).not.toMatch(/"global"/);

    const watch = sidebar.indexOf('e.affectsConfiguration("grok.projects.workspaceOnly")');
    expect(watch).toBeGreaterThan(-1);
    const watcher = sidebar.slice(watch, sidebar.indexOf("this.postRepoCatalog();", watch) + "this.postRepoCatalog();".length);
    expect(watcher).toMatch(/type: "projectsWorkspaceOnly"/);
    expect(watcher).toMatch(/this\.post\(message\)/);
    expect(watcher).toMatch(/this\.settingsEditor\?\.webview\.postMessage\(message\)/);
  });
});

describe("a file belongs to a conversation, not to the window", () => {
  // The containment rule behind the implicit editor chip. Once history follows
  // the rail, VS Code's active editor can be a project-A file while the focused
  // conversation is project B's — and for a SELECTION the prompt builder reads
  // that absolute path and embeds A's source under an A-relative name.
  it("returns a forward-slashed path for a file inside the root", () => {
    expect(relativePathWithin("/work/app", "/work/app/src/a.ts", "linux")).toBe("src/a.ts");
    expect(
      relativePathWithin("C:\\work\\app", "C:\\work\\app\\src\\a.ts", "win32"),
    ).toBe("src/a.ts");
  });

  it("refuses a sibling that merely shares a name prefix", () => {
    // The bug a plain startsWith() would ship.
    expect(relativePathWithin("/work/app", "/work/app-two/src/a.ts", "linux")).toBeUndefined();
  });

  it("refuses a file in another project outright", () => {
    expect(relativePathWithin("/work/relay", "/work/app/src/a.ts", "linux")).toBeUndefined();
  });

  it("treats Windows case and separator differences as the same directory", () => {
    expect(relativePathWithin("C:\\Work\\App", "c:/work/app/src/a.ts", "win32")).toBe("src/a.ts");
  });

  it("is case-SENSITIVE off Windows, where two casings are two directories", () => {
    expect(relativePathWithin("/work/App", "/work/app/a.ts", "linux")).toBeUndefined();
  });

  it("refuses the root itself and empty inputs", () => {
    expect(relativePathWithin("/work/app", "/work/app", "linux")).toBeUndefined();
    expect(relativePathWithin("", "/work/app/a.ts", "linux")).toBeUndefined();
    expect(relativePathWithin("/work/app", "", "linux")).toBeUndefined();
  });

  it("is what refreshImplicitChip gates on, and the source of the relative path", () => {
    // asRelativePath resolves against VS CODE's workspace folders, and a project
    // reached through the rail is deliberately not one of them — it would have
    // handed back an absolute path for an ordinary file in its own repo.
    const body = methodBody("private refreshImplicitChip(");
    expect(body).toMatch(/this\.conversationRelPath\(absPath\)/);
    expect(body).not.toMatch(/this\.host\.asRelativePath/);
  });

  it("resolves canonically, so a symlink cannot smuggle another project in", () => {
    // The lexical check alone is not a fence. A symlink — or a Windows junction
    // — inside project B pointing at project A passes it as `linked/secret.ts`,
    // because the file genuinely is at that path in B. But buildPrompt opens the
    // absolute path and reads whatever is on the other end, so A's source lands
    // in B's conversation under a name that looks like B's own. The remote file
    // browser has always canonicalised (resolveTreePath); this must too.
    const body = methodBody("private conversationRelPath(");
    expect(body).toMatch(/relativePathWithin\(fs\.realpathSync\([^)]*\), fs\.realpathSync\([^)]*\)\)/);
    // Unprovable is refused, not waved through.
    expect(body).toMatch(/catch\s*\{\s*return undefined;/);
  });
});

describe("cross-project fallout of following the selection", () => {
  it("gives the post-delete replacement session the selected project's cwd", () => {
    // Delete the active conversation while the rail sits on project B and the
    // window has A open: the replacement used to start in A, silently, with
    // history and the rail still reading B.
    // Renamed from `wasFocused`: the snapshot taken before the provider
    // teardown could not see a view that navigated onto the conversation
    // while it was being deleted. The cwd rule this test guards is unchanged.
    const at = sidebar.indexOf("if (viewNeedsHome) {");
    expect(at).toBeGreaterThan(-1);
    const arm = sidebar.slice(at, sidebar.indexOf("}", sidebar.indexOf("startSession()", at)));
    expect(arm).toMatch(/this\.setSessionCwd\(\s*this\.focused,\s*this\.historyCwdFor\("local"\)/);
  });

  it("will not tear down a session that is still starting", () => {
    // `hasHistory` is the "this conversation is real" flag, and on a RESUME it
    // is set at the very end of startSession — after the session id arrives and
    // after the default-model await. In that window a resumed conversation looks
    // like an untouched new one, and parkFocused deletes those from disk. Two
    // rail clicks in a row reach it: loads are reserved per session id, so the
    // second resume is not blocked by the first.
    const body = methodBody("private parkFocused()");
    expect(body).toMatch(/if \(cur\.priming\) return;/);
    // …and the guard has to come first, or it guards nothing.
    expect(body.indexOf("cur.priming")).toBeLessThan(body.indexOf("removeSessionFromDisk"));
  });
});

describe("the very first conversation", () => {
  it("starts in the selected project, not the open folder", () => {
    // The pristine session carries no cwd and startSession's fallback is the
    // WORKSPACE ROOT, so a project chosen in the rail before the chat view was
    // ever revealed was ignored by the first conversation: rail and history said
    // B while the agent ran in A, and the first prompt could read or write A.
    // Every other entry point sets this; the one that starts by itself did not.
    const at = sidebar.indexOf('void this.startSession(undefined, this.focused, "ensure").then(');
    expect(at).toBeGreaterThan(-1);
    const before = sidebar.slice(Math.max(0, at - 700), at);
    expect(before).toMatch(/if \(!this\.focused\.cwd\)/);
    expect(before).toMatch(/this\.setSessionCwd\(\s*this\.focused,\s*this\.historyCwdFor\("local"\)/);
  });
});

describe("a row that names its own project", () => {
  it("is honoured by a local delete, resolved through the catalog", () => {
    // The rail lists other projects' conversations, and their rows carry a cwd
    // the delete chain ignored. Rename a cold conversation in B (which drops its
    // cache entry), then Delete that row: it resolved to the SELECTED project,
    // deleted nothing, reported nothing wrong, and the conversation came back
    // under its old name.
    const body = methodBody("private async deleteSession(");
    expect(body).toMatch(/origin === "local" && requestedCwd/);
    expect(body).toMatch(/resolveLocalRepoTarget\(requestedCwd\)/);
    // Ordered AFTER the evidence-bearing sources and BEFORE the scope fallback.
    const named = body.indexOf("localNamedCwd ||");
    const scope = body.indexOf('this.historyCwdFor(origin)');
    expect(named).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(named);
  });

  it("has its project's rail list refreshed after a rename", () => {
    // postSessionsList only refreshes the SELECTED project; every other project
    // in the rail is drawn from its repoSessions preview.
    const body = methodBody("private renameSession(");
    expect(body).toMatch(/sendLocalRepoSessionsPreview\(localCwd\)/);
  });
});

describe("removing a project ends what is running in it", () => {
  it("warns about work in flight and revokes, like the desktop close", () => {
    // Tombstoning the row stopped new remote frames but left an agent already
    // running in that folder executing commands and writing files — while the
    // confirmation said "Nothing on disk is touched".
    const body = methodBody("private async forgetExtraProjectFolder(");
    expect(body).toMatch(/sessionsBoundToFolder\(cwd\)\.filter\(sessionHasWorkInFlight\)/);
    expect(body).toMatch(/"Hide anyway"/);
    expect(body).toMatch(/this\.revokeClosedProjectFolder\(cwd\)/);
    // Revoke AFTER the tombstone is written, so the folder has already left the
    // authorized set and a concurrent remote send cannot route into a doomed
    // session — the same ordering the desktop close uses.
    expect(body.indexOf("REMOVED_PROJECT_FOLDERS_KEY")).toBeLessThan(
      body.indexOf("revokeClosedProjectFolder"),
    );
  });

  it("labels a worktree conversation with its owning project", () => {
    // A worktree's cwd is deliberately not a catalog row, so a client resolving
    // the label from cwd alone falls back to that directory's leaf — and where
    // the leaf matches another project's name, A's conversation is presented as
    // B. The host names the owner when the two differ.
    const body = methodBody("private postSessionName(");
    expect(body).toMatch(/resolveLocalRepoTarget\(cwd\)/);
    expect(body).toMatch(/repoCwd: owner/);
  });
});
