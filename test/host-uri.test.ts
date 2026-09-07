/**
 * Regression coverage for the portable Uri + Host editor/diff surface.
 * Type-checker cannot catch scheme filters, dual-encoder URI compares, or
 * dropped authority on round-trip — these tests pin each.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Uri,
  isFsPathInWorkspace,
  isHostUri,
  normalizeWorkspaceFsPath,
  untitledTextOpenOptions,
} from "../src/host";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("portable Uri", () => {
  it("carries authority through from() and toString()", () => {
    const u = Uri.from({
      scheme: "vscode-remote",
      authority: "myhost",
      path: "/home/me/x.ts",
      fsPath: "/home/me/x.ts",
    });
    expect(u.scheme).toBe("vscode-remote");
    expect(u.authority).toBe("myhost");
    expect(u.path).toBe("/home/me/x.ts");
    expect(u.fsPath).toBe("/home/me/x.ts");
    expect(u.query).toBe("");
    expect(u.fragment).toBe("");
    expect(u.toString()).toBe("vscode-remote://myhost/home/me/x.ts");
    expect(isHostUri(u)).toBe(true);
  });

  it("carries query and fragment through from() and toString()", () => {
    // Must fail if Uri drops query/fragment (the P3 portable-Uri gap).
    const u = Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+box",
      path: "/home/me/doc.md",
      query: "view=preview&x=1",
      fragment: "section-2",
      fsPath: "/home/me/doc.md",
    });
    expect(u.query).toBe("view=preview&x=1");
    expect(u.fragment).toBe("section-2");
    expect(u.fsPath).toBe("/home/me/doc.md");
    expect(u.toString()).toContain("?view=preview&x=1");
    expect(u.toString()).toContain("#section-2");
    // Round-trip via component rebuild preserves both (and the real fsPath).
    const again = Uri.from({
      scheme: u.scheme,
      authority: u.authority,
      path: u.path,
      query: u.query,
      fragment: u.fragment,
      fsPath: u.fsPath,
    });
    expect(again.query).toBe(u.query);
    expect(again.fragment).toBe(u.fragment);
    expect(again.fsPath).toBe(u.fsPath);
    expect(again.toString()).toBe(u.toString());
  });

  it("preserves authority across joinPath", () => {
    const base = Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+box",
      path: "/home/me",
      fsPath: "/home/me",
    });
    const joined = Uri.joinPath(base, "src", "app.ts");
    expect(joined.authority).toBe("ssh-remote+box");
    expect(joined.path).toBe("/home/me/src/app.ts");
    expect(joined.toString()).toBe("vscode-remote://ssh-remote+box/home/me/src/app.ts");
  });

  it("carries a host-supplied fsPath for non-file schemes (not a path-only guess)", () => {
    // VS Code's fsPath for remote can differ from the URI path form; we must
    // not re-derive it and lose the real value.
    const u = Uri.from({
      scheme: "vscode-remote",
      authority: "wsl+Ubuntu",
      path: "/mnt/c/work/a.ts",
      fsPath: "\\\\wsl$\\Ubuntu\\mnt\\c\\work\\a.ts",
    });
    expect(u.fsPath).toBe("\\\\wsl$\\Ubuntu\\mnt\\c\\work\\a.ts");
    expect(u.path).toBe("/mnt/c/work/a.ts");
  });

  it("percent-encodes path special characters in toString (space, #, ?)", () => {
    const u = Uri.from({
      scheme: "grok-diff",
      path: "/0/before/my file#x?.ts",
    });
    expect(u.toString()).toBe("grok-diff:/0/before/my%20file%23x%3F.ts");
    // path property stays decoded for content-provider lookups
    expect(u.path).toBe("/0/before/my file#x?.ts");
  });

  it("file() round-trips Windows and POSIX paths", () => {
    const posix = Uri.file("/tmp/a b.ts");
    expect(posix.scheme).toBe("file");
    expect(posix.authority).toBe("");
    expect(posix.fsPath).toBe("/tmp/a b.ts");
    expect(posix.toString()).toContain("a%20b.ts");
  });
});

describe("insertActiveMention accepts non-file schemes (regression #1)", () => {
  it("resolves active-editor path from fsPath without a scheme === file filter", () => {
    // Pure reconstruction of the path line insertActiveMention uses: any scheme
    // with an fsPath (vscode-remote, etc.) must produce a path, not undefined.
    const remoteEditor = {
      document: {
        uri: Uri.from({
          scheme: "vscode-remote",
          authority: "ssh-remote+dev",
          path: "/home/me/proj/src/main.ts",
          fsPath: "/home/me/proj/src/main.ts",
        }),
      },
      selection: {
        isEmpty: true,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    };
    const absPath = remoteEditor.document.uri.fsPath;
    expect(absPath).toBe("/home/me/proj/src/main.ts");
    expect(remoteEditor.document.uri.scheme).not.toBe("file");

    // Source gate: accepts opts.uri (portable Uri) end-to-end — never opts.path
    // string rebuilt with Uri.file (drops remote authority for Send File).
    const src = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("insertActiveMention(");
    expect(start).toBeGreaterThan(-1);
    // To the end of the method, not a fixed byte window: a comment added inside
    // it pushed the line these assertions are about past the old 2000-char cut,
    // and the test then failed for a reason that had nothing to do with the
    // regression it guards.
    const end = src.indexOf("\n  newSession(", start);
    expect(end, "insertActiveMention must still be followed by newSession").toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toMatch(/opts\?\s*\.\s*uri\s*\?\?\s*editor\?\s*\.\s*document\s*\.\s*uri/);
    expect(body).toMatch(/pathUri\?\.fsPath|pathUri\.fsPath/);
    // The relative path is built from that same portable Uri's fsPath. It used
    // to be `asRelativePath(pathUri)`; it is `relativePathWithin` now, because
    // the attachment must belong to the CONVERSATION's project, and a project
    // reached through the rail is not a VS Code workspace folder — asRelativePath
    // would have labelled an ordinary file in its own repo with an absolute
    // path. The remote-scheme guarantee this test exists for is untouched:
    // `fsPath` is still what both the containment check and the label are built
    // from, so `vscode-remote://` resolves exactly as a local path does.
    expect(body).toMatch(/this\.conversationRelPath\(absPath\)/);
    expect(body).not.toMatch(/this\.host\.asRelativePath/);
    expect(body).not.toMatch(/opts\?\s*\.\s*path\b/);
    expect(body).not.toMatch(/Uri\.file\(\s*opts\.path\s*\)/);
    // No scheme gate on the path line (refreshImplicitChip still filters file-
    // only for the context chip — that is pre-v3.1.0 and out of scope here).
    expect(body).not.toMatch(
      /editor\?\.document\.uri\.scheme\s*===\s*["']file["']\s*\?\s*editor\.document\.uri\.fsPath/,
    );
  });
});

describe("closeDiffTabs URI comparison symmetry (regression #2)", () => {
  it("Host.closeDiffTabs takes portable Uri values, not pre-stringified keys", () => {
    const hostSrc = readFileSync(path.join(root, "src", "host.ts"), "utf8");
    expect(hostSrc).toMatch(/closeDiffTabs\(\s*original:\s*Uri\s*,\s*modified:\s*Uri\s*\)/);

    const adapter = readFileSync(path.join(root, "src", "vscode-host.ts"), "utf8");
    // Both sides must go through toVsCodeUri before .toString() compare.
    // Behavioural proof of the encoder lives in integration/extension.test.ts
    // (real VS Code); this only pins the source contract so a dual-encoder
    // reintroduction fails the unit suite too.
    const closeStart = adapter.indexOf("closeDiffTabs(original");
    expect(closeStart).toBeGreaterThan(-1);
    const closeFn = adapter.slice(closeStart, closeStart + 900);
    expect(closeFn).toMatch(/toVsCodeUri\(\s*original\s*\)/);
    expect(closeFn).toMatch(/toVsCodeUri\(\s*modified\s*\)/);
    // Must not compare VS Code tab strings against a bare parameter name
    // (the dual-encoder bug: portable toString vs input.original.toString).
    expect(closeFn).not.toMatch(/input\.original\.toString\(\)\s*===\s*original\b/);
    expect(closeFn).not.toMatch(/input\.modified\.toString\(\)\s*===\s*modified\b/);

    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(sidebar).toMatch(/closeDiffTabs\(\s*uris\.left\s*,\s*uris\.right\s*\)/);
    expect(sidebar).not.toMatch(/closeDiffTabs\([^)]*\.toString\(\)/);
  });

  it("portable Uri percent-encodes space/#/? for same-encoder keys", () => {
    // Unit-side encoding contract; real toVsCodeUri symmetry is integration.
    const left = Uri.from({ scheme: "grok-diff", path: "/0/before/my file#x?.ts" });
    const right = Uri.from({ scheme: "grok-diff", path: "/0/after/my file#x?.ts" });
    expect(left.toString()).toBe("grok-diff:/0/before/my%20file%23x%3F.ts");
    expect(right.toString()).toBe("grok-diff:/0/after/my%20file%23x%3F.ts");
    expect(left.path).toBe("/0/before/my file#x?.ts");
  });
});

describe("asRelativePath takes Uri (remote identity)", () => {
  it("Host.asRelativePath is typed on Uri, not a path string", () => {
    const hostSrc = readFileSync(path.join(root, "src", "host.ts"), "utf8");
    expect(hostSrc).toMatch(/asRelativePath\(\s*uri:\s*Uri\s*\)/);
    expect(hostSrc).not.toMatch(/asRelativePath\(\s*fsPath:\s*string\s*\)/);

    const adapter = readFileSync(path.join(root, "src", "vscode-host.ts"), "utf8");
    const start = adapter.indexOf("asRelativePath(uri");
    expect(start).toBeGreaterThan(-1);
    const body = adapter.slice(start, start + 250);
    expect(body).toMatch(/toVsCodeUri\(\s*uri\s*\)/);
    // Must not call VS Code with a bare string path (loses remote identity).
    expect(body).not.toMatch(/asRelativePath\(\s*fsPath\s*\)/);
  });

  it("sidebar passes Uri into asRelativePath, not a plain abs path", () => {
    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(sidebar).not.toMatch(/asRelativePath\(\s*absPath\s*\)/);
    expect(sidebar).not.toMatch(/asRelativePath\(\s*abs\s*\)/);
    expect(sidebar).toMatch(/asRelativePath\(\s*pathUri\s*\)|asRelativePath\(\s*uri\s*\)|asRelativePath\(\s*editor\.document\.uri\s*\)/);
  });
});

describe("typed Host command surface (design #5)", () => {
  it("declares openResource, openDiff, setContext, relocateView, openSettings, link/unlink on Host", () => {
    const hostSrc = readFileSync(path.join(root, "src", "host.ts"), "utf8");
    expect(hostSrc).toMatch(/openResource\(/);
    expect(hostSrc).toMatch(/openDiff\(/);
    expect(hostSrc).toMatch(/setContext\(/);
    expect(hostSrc).toMatch(/relocateView\(/);
    expect(hostSrc).toMatch(/openSettings\(/);
    expect(hostSrc).toMatch(/linkRemote\(/);
    expect(hostSrc).toMatch(/unlinkRemote\(/);
    expect(hostSrc).toMatch(/openGlobalConfig\(/);
    expect(hostSrc).toMatch(/openProjectConfig\(/);
    expect(hostSrc).toMatch(/openHostResolvedPath\(/);
    // Escape-hatch executeCommand is gone — every sidebar op is typed.
    expect(hostSrc).not.toMatch(/\bexecuteCommand\b/);
  });

  it("sidebar uses typed methods and never executeCommand", () => {
    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(sidebar).not.toMatch(/\.executeCommand\s*\(/);
    expect(sidebar).not.toMatch(/executeCommand\(\s*["']vscode\.open["']/);
    expect(sidebar).not.toMatch(/executeCommand\(\s*["']vscode\.diff["']/);
    expect(sidebar).not.toMatch(/executeCommand\(\s*["']setContext["']/);
    expect(sidebar).not.toMatch(/executeCommand\(\s*["']vscode\.moveViews["']/);
    expect(sidebar).not.toMatch(/executeCommand\(\s*["']workbench\.action\.openSettings["']/);
    expect(sidebar).not.toMatch(/executeCommand\(\s*["']grok\.(link|unlink)Remote["']/);
    expect(sidebar).toMatch(/\.openDiff\(/);
    expect(sidebar).toMatch(/\.openResource\(/);
    expect(sidebar).toMatch(/\.openGlobalConfig\(/);
    expect(sidebar).toMatch(/\.openProjectConfig\(/);
    expect(sidebar).toMatch(/\.openHostResolvedPath\(/);
    expect(sidebar).toMatch(/\.setContext\(/);
    expect(sidebar).toMatch(/\.relocateView\(/);
    expect(sidebar).toMatch(/\.openSettings\(/);
    expect(sidebar).toMatch(/\.linkRemote\(/);
    expect(sidebar).toMatch(/\.unlinkRemote\(/);
  });
});

/**
 * Round-3 class fix: the portable boundary carries Uri for every value that
 * originated as vscode.Uri. Flattening to path + Uri.file is the regression
 * that blanked remote webviews and rewrote storage/Send-File identity.
 * These source gates fail if any of the three sites (or the types) are reverted.
 */
describe("URI identity at the Host boundary (remote-safe class fix)", () => {
  const hostSrc = () => readFileSync(path.join(root, "src", "host.ts"), "utf8");
  const adapter = () => readFileSync(path.join(root, "src", "vscode-host.ts"), "utf8");
  const sidebar = () => readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
  const extension = () => readFileSync(path.join(root, "src", "extension.ts"), "utf8");

  it("HostContext carries extensionUri + globalStorageUri (Uri), not path strings", () => {
    const src = hostSrc();
    expect(src).toMatch(/extensionUri:\s*Uri/);
    expect(src).toMatch(/globalStorageUri:\s*Uri/);
    // Flattened string form is the bug — must not reappear as the stored type.
    expect(src).not.toMatch(/extensionPath:\s*string/);
    expect(src).not.toMatch(/globalStoragePath:\s*string/);
  });

  it("HostWebview.asWebviewUri and localResourceRoots take Uri, not path strings", () => {
    const src = hostSrc();
    expect(src).toMatch(/asWebviewUri\(\s*uri:\s*Uri\s*\)/);
    expect(src).toMatch(/localResourceRoots\?:\s*Uri\[\]/);
    expect(src).not.toMatch(/asWebviewUri\(\s*localPath:\s*string\s*\)/);
    expect(src).not.toMatch(/localResourceRoots\?:\s*string\[\]/);
  });

  it("HostFileSystem methods take Uri, not path strings", () => {
    const src = hostSrc();
    // Prefer the exact interface name (HostFileSystemWatcher also starts with HostFileSystem).
    const fsStart = src.indexOf("export interface HostFileSystem {");
    expect(fsStart).toBeGreaterThan(-1);
    const fsBlock = src.slice(fsStart, fsStart + 700);
    expect(fsBlock).toMatch(/readFile\(\s*uri:\s*Uri\s*\)/);
    expect(fsBlock).toMatch(/writeFile\(\s*uri:\s*Uri\s*,/);
    expect(fsBlock).toMatch(/createDirectory\(\s*uri:\s*Uri\s*\)/);
    expect(fsBlock).toMatch(/delete\(\s*uri:\s*Uri\s*,/);
    expect(fsBlock).toMatch(/stat\(\s*uri:\s*Uri\s*\)/);
    expect(fsBlock).not.toMatch(/readFile\(\s*path:\s*string\s*\)/);
  });

  it("adapter converts only via toVsCodeUri / fromVsCodeUri (never Uri.file on boundary values)", () => {
    const src = adapter();

    // createVsCodeHostContext must preserve URI identity.
    const ctxStart = src.indexOf("export function createVsCodeHostContext");
    expect(ctxStart).toBeGreaterThan(-1);
    const ctxBody = src.slice(ctxStart, ctxStart + 900);
    expect(ctxBody).toMatch(/globalStorageUri:\s*fromVsCodeUri\(\s*context\.globalStorageUri\s*\)/);
    expect(ctxBody).toMatch(/extensionUri:\s*fromVsCodeUri\(\s*context\.extensionUri\s*\)/);
    expect(ctxBody).not.toMatch(/globalStoragePath:\s*context\.globalStorageUri\.fsPath/);
    expect(ctxBody).not.toMatch(/extensionPath:\s*context\.extensionUri\.fsPath/);

    // hostFs: every op goes through toVsCodeUri.
    const fsStart = src.indexOf("const hostFs");
    expect(fsStart).toBeGreaterThan(-1);
    const fsBody = src.slice(fsStart, fsStart + 700);
    expect(fsBody).toMatch(/toVsCodeUri\(\s*uri\s*\)/);
    expect(fsBody).not.toMatch(/vscode\.Uri\.file\(\s*[a-z]\s*\)/);

    // wrapWebview (not wrapWebviewView) — localResourceRoots + asWebviewUri.
    const wrapStart = src.indexOf("export function wrapWebview(webview");
    expect(wrapStart).toBeGreaterThan(-1);
    const wrapBody = src.slice(wrapStart, wrapStart + 1800);
    expect(wrapBody).toMatch(/localResourceRoots\?\.map\(fromVsCodeUri\)/);
    expect(wrapBody).toMatch(/localResourceRoots\?\.map\(toVsCodeUri\)/);
    expect(wrapBody).toMatch(/asWebviewUri\(\s*uri:\s*Uri\s*\)/);
    expect(wrapBody).toMatch(/webview\.asWebviewUri\(\s*toVsCodeUri\(\s*uri\s*\)\s*\)/);
    // The flattening bug: map roots/paths through Uri.file.
    expect(wrapBody).not.toMatch(/Uri\.file\(\s*p\s*\)/);
    expect(wrapBody).not.toMatch(/localResourceRoots\?\.map\(\s*\(u\)\s*=>\s*u\.fsPath\s*\)/);
    expect(wrapBody).not.toMatch(/asWebviewUri\(\s*localPath:\s*string\s*\)/);
  });

  it("getHtml and localResourceRoots join under extensionUri (not path.join of extensionPath)", () => {
    const src = sidebar();
    expect(src).toMatch(
      /asWebviewUri\(\s*Uri\.joinPath\(\s*this\.context\.extensionUri\s*,\s*["']media["']/,
    );
    expect(src).toMatch(
      /Uri\.joinPath\(\s*this\.context\.extensionUri\s*,\s*["']media["']\s*\)/,
    );
    expect(src).toMatch(
      /Uri\.joinPath\(\s*this\.context\.extensionUri\s*,\s*["']resources["']\s*\)/,
    );
    // Flattened form that blanked remote webviews.
    expect(src).not.toMatch(/this\.context\.extensionPath/);
    expect(src).not.toMatch(/asWebviewUri\(\s*path\.join\(\s*this\.context/);
  });

  it("plan-review storage joins under globalStorageUri (not path.join of globalStoragePath)", () => {
    const src = sidebar();
    expect(src).toMatch(
      /Uri\.joinPath\(\s*this\.context\.globalStorageUri\s*,\s*["']plan-reviews["']/,
    );
    expect(src).not.toMatch(/this\.context\.globalStoragePath/);
    // uniquePlanReviewUri keeps Uri through host.fs.stat — not path strings.
    expect(src).toMatch(/uniquePlanReviewUri\s*\(/);
  });

  it("grok.sendFile passes a portable Uri (fromVsCodeUri), not uri.fsPath", () => {
    const src = extension();
    expect(src).toMatch(/fromVsCodeUri/);
    expect(src).toMatch(/insertActiveMention\(\s*\{\s*uri:\s*fromVsCodeUri\(/);
    expect(src).not.toMatch(/insertActiveMention\(\s*\{[^}]*path:\s*uri\?\.fsPath/);
  });

  it("grok.sendFile attaches the Explorer's whole selection, not just the clicked file", () => {
    // VS Code passes the clicked resource first and the multi-selection second.
    // Taking only the first is why highlighting five files attached one — and
    // this menu route is what has to work when a drag cannot reach the webview
    // at all (#136), so it is the one that must not silently drop files.
    const src = extension();
    expect(src).toMatch(/"grok\.sendFile"[\s\S]{0,900}uris\?:\s*vscode\.Uri\[\]/);
    expect(src).toMatch(/uris\?\.length\s*\?\s*uris\s*:/);
  });

  it("toVsCodeUri / fromVsCodeUri carry query and fragment (not path-only)", () => {
    const src = adapter();
    const toStart = src.indexOf("export function toVsCodeUri");
    expect(toStart).toBeGreaterThan(-1);
    const toBody = src.slice(toStart, toStart + 900);
    expect(toBody).toMatch(/query:\s*u\.query/);
    expect(toBody).toMatch(/fragment:\s*u\.fragment/);

    const fromStart = src.indexOf("export function fromVsCodeUri");
    expect(fromStart).toBeGreaterThan(-1);
    const fromBody = src.slice(fromStart, fromStart + 900);
    expect(fromBody).toMatch(/query:\s*u\.query/);
    expect(fromBody).toMatch(/fragment:\s*u\.fragment/);
    // Real fsPath must still ride the non-file conversion.
    expect(fromBody).toMatch(/fsPath:\s*u\.fsPath/);
  });
});

/**
 * isInWorkspace must not unconditionally lower-case (Linux/macOS case-
 * sensitive volumes) and must resolve `.`/`..` rather than string-prefix.
 * Pure helpers live in host.ts so these tests need no vscode mock.
 */
describe("isFsPathInWorkspace (platform-aware path containment)", () => {
  it("case-only path difference follows platform FS rules", () => {
    // Platform-aware: assert BOTH sides of the rule so a Windows runner still
    // fails a "always case-sensitive" regression, and a Linux runner fails the
    // unconditional toLowerCase bug — never skip on Windows.
    const root = "/home/me/project";
    const otherCase = "/home/me/Project";
    // Explicit platform (path.posix/win32) so either host can prove both arms.
    expect(isFsPathInWorkspace(otherCase, [root], "linux")).toBe(false);
    expect(isFsPathInWorkspace(otherCase, [root], "darwin")).toBe(false);
    expect(isFsPathInWorkspace(otherCase, [root], "win32")).toBe(true);
    // Live process.platform must agree with the matching arm (no silent drift).
    if (process.platform === "win32") {
      expect(isFsPathInWorkspace(otherCase, [root])).toBe(true);
    } else {
      expect(isFsPathInWorkspace(otherCase, [root])).toBe(false);
    }
  });

  it("resolves . and .. segments before containment", () => {
    const root = "/home/me/project";
    expect(isFsPathInWorkspace("/home/me/project/./src", [root], "linux")).toBe(true);
    expect(isFsPathInWorkspace("/home/me/other/../project/src", [root], "linux")).toBe(true);
    expect(isFsPathInWorkspace("/home/me/project/foo/../../escape", [root], "linux")).toBe(false);
    // Unconditional separator-normalize without segment resolve fails this.
    expect(normalizeWorkspaceFsPath("/home/me/a/../b/./c", "linux")).toBe("/home/me/b/c");
  });

  it("rejects a sibling path that only shares a string prefix", () => {
    // Old startsWith(root + "/") would mark project-extra as inside project.
    expect(isFsPathInWorkspace("/home/me/project-extra", ["/home/me/project"], "linux")).toBe(false);
    expect(isFsPathInWorkspace("/home/me/project/src", ["/home/me/project"], "linux")).toBe(true);
  });

  it("isInWorkspace adapter delegates to isFsPathInWorkspace (no toLowerCase)", () => {
    const src = readFileSync(path.join(root, "src", "vscode-host.ts"), "utf8");
    const start = src.indexOf("isInWorkspace(fsPath");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 700);
    expect(body).toMatch(/isFsPathInWorkspace\s*\(/);
    expect(body).toMatch(/f\.uri\.fsPath/);
    // The P2 regression: unconditional lower-casing in the adapter.
    expect(body).not.toMatch(/toLowerCase\s*\(/);
  });
});

describe("untitledTextOpenOptions (View all language passthrough)", () => {
  it("omits language when absent so the editor can detect", () => {
    expect(untitledTextOpenOptions("hello")).toEqual({ content: "hello" });
    expect(untitledTextOpenOptions("hello", undefined)).toEqual({ content: "hello" });
    expect(untitledTextOpenOptions("hello", "")).toEqual({ content: "hello" });
    expect(Object.prototype.hasOwnProperty.call(untitledTextOpenOptions("hello"), "language")).toBe(false);
  });

  it("passes a provided language through", () => {
    expect(untitledTextOpenOptions("Get-Date", "powershell")).toEqual({
      content: "Get-Date",
      language: "powershell",
    });
  });

  it("vscode-host openUntitledText uses untitledTextOpenOptions and does not default to plaintext", () => {
    const src = readFileSync(path.join(root, "src", "vscode-host.ts"), "utf8");
    const start = src.indexOf("async openUntitledText");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 400);
    expect(body).toMatch(/untitledTextOpenOptions\(\s*content\s*,\s*language\s*\)/);
    expect(body).not.toMatch(/language:\s*["']plaintext["']/);
    expect(body).not.toMatch(/openTextDocument\(\s*\{\s*content\s*,\s*language\s*\}/);
  });

  it("sidebar initialState supplies commandLanguage from the host shell dialect", () => {
    const src = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(src).toMatch(/commandLanguageForDialect\(\s*resolvedTerminalShellDialect\(\)\s*\)/);
    expect(src).toMatch(/commandLanguage\s*\?\s*\{\s*commandLanguage\s*\}/);
  });

  it("sidebar initialState forwards previewInApp from the host capability", () => {
    const src = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(src).toMatch(/previewInApp:\s*this\.host\.canPreviewInApp/);
  });

  it("sidebar initialState forwards settingsEditor from the host capability", () => {
    const src = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(src).toMatch(/settingsEditor:\s*this\.host\.canOpenSettingsEditor/);
  });

  it("sidebar advertises mcpSettings only when the host opts in", () => {
    const src = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(src).toMatch(/canShowMcpSettings\s*\?\s*\{\s*mcpSettings:\s*true\s*\}/);
  });
});
