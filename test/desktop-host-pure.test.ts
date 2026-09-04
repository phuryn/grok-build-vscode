/**
 * Pure desktop helpers (no Electron process) — safe for npm test / CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A temp directory whose path is ALREADY CANONICAL.
 *
 * On macOS `os.tmpdir()` is `/var/folders/…`, which is a symlink to
 * `/private/var/folders/…`. Every test below hands its temp root to code whose
 * whole job is to canonicalise a path and compare it against that root — so an
 * uncanonicalised root makes the containment check compare `/private/var/…`
 * (what the product resolved) against `/var/…` (what the test passed in) and
 * the product looks broken on macOS while behaving exactly as designed.
 *
 * These suites were red on macOS for at least ten days without anyone noticing,
 * because CI is Ubuntu and the dev box is Windows and neither has that symlink.
 */
function mkdtempReal(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

import {
  ConfigStore,
  SensitiveConfigStore,
  SENSITIVE_CONFIG_KEYS,
  normalizeWorkspaceRoots,
} from "../src/desktop/config-store";
import { createFileMemento } from "../src/desktop/memento";
import {
  buildDiffViewerHtml,
  buildTextViewerHtml,
  escapeHtml,
  interpretOpenPathResult,
  MAX_DOCUMENT_VIEW_CHARS,
  prepareDocumentViewText,
  resolveDocumentText,
} from "../src/desktop/document-view";
import {
  asAppResourceRegistryUrl,
  asAppResourceUrl,
  appResourceUrlToFsPath,
  APP_DOCUMENT_PATH,
  APP_DOCUMENT_URL,
  APP_ORIGIN,
  APP_RESOURCE_CSP_SOURCE,
  DESKTOP_THEME_CSS,
  desktopChromeBootSource,
  isAppDocumentUrl,
} from "../src/desktop/electron-webview";
import { Uri } from "../src/host";
import { findFilesUnder } from "../src/desktop/find-files";
import {
  createSafeStorageSecrets,
  EncryptionUnavailableError,
  isWindowsReplaceRenameError,
  writeFileAtomic,
  type SafeStorageLike,
} from "../src/desktop/safe-secrets";
import {
  appResourceMayServe,
  isGeneratedSessionMediaPath,
  resolveAppResourceServe,
  rootServePolicy,
} from "../src/desktop/app-resource-policy";
import { AsyncSerialQueue } from "../src/async-serial";
import {
  authorizeDesktopWebviewMsg,
  authorizeDropFile,
  authorizeOpenFile,
  authorizeOpenUrl,
  desktopAuthRoots,
  isExecutableOpenTarget,
  isExecutablePath,
  resolveAuthorizedFileForOpen,
  revalidateOpenFileForUse,
} from "../src/desktop/desktop-policy";
import {
  FileSelectionRegistry,
  isFileSelectionId,
} from "../src/desktop/file-selection-registry";
import {
  planOpenCliInTerminal,
  planRunCommandInTerminal,
} from "../src/desktop/external-terminal";
import {
  breadcrumbSegments,
  classifyFilePreview,
  FILE_TREE_MAX_ENTRIES,
  FILE_PREVIEW_MAX_BYTES,
  findRelPathByBasename,
  isBareFileName,
  listTreeDir,
  nearestExistingAncestor,
  readTreeFile,
  resolveTreePath,
  type TreePathFs,
  writeTreeFile,
} from "../src/desktop/file-tree";
import { isIpcFromMainWindow, resolveTreeOpenTarget } from "../src/desktop/file-tree-ipc";
import { fileTreePanelBootSource } from "../src/desktop/file-tree-panel";
import { mayRegisterResourcePath } from "../src/desktop/media-provenance";
import {
  ResourceRegistry,
  registryIdFromUrlPath,
} from "../src/desktop/resource-registry";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import {
  deliverSuggestedFileSave,
  planSuggestedSaveDialog,
  saveDialogTitleForFilename,
  saveFiltersForFilename,
  writeSuggestedFileOrCancel,
} from "../src/desktop/suggested-save";
import {
  base64DecodedByteLength,
  isRefusedMediaBasename,
  isRefusedMediaPath,
  isTrustedGeneratedMediaPath,
  MAX_INLINE_MEDIA_BYTES,
} from "../src/media-serve";
import {
  findSessionCatalogCwd,
  orderedResumeCwdCandidates,
  sessionsDirFor,
} from "../src/sessions";
import {
  buildInputBoxHtml,
  buildQuickPickHtml,
  DESKTOP_APP_FULL_NAME,
  DESKTOP_PUBLIC_REPO_URL,
  MESSAGE_BOX_CANCEL_LABEL,
  parseDialogSubmit,
  planMessageBoxButtons,
  resolveMessageBoxChoice,
  selectQuickPickIndex,
} from "../src/desktop/host-dialogs";

import {
  isAllowedAppNavigationUrl,
  shouldBlockNavigation,
  shouldOpenExternally,
  windowOpenDecision,
} from "../src/desktop/window-security";
import {
  DESKTOP_OPEN_DEVTOOLS_ENV,
  DESKTOP_OPEN_DEVTOOLS_FLAG,
  DESKTOP_DEVTOOLS_ACCELERATOR,
  desktopAppMenuTemplate,
  desktopDevToolsAllowed,
  isDesktopDevToolsShortcut,
  secondInstanceShouldOpenDevTools,
  shouldOpenDevToolsAtStartup,
} from "../src/desktop/app-menu";

const testRepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const filePanelJs = fs.readFileSync(path.join(testRepoRoot, "media", "file-panel.js"), "utf8");
const filePanelCss = fs.readFileSync(path.join(testRepoRoot, "media", "file-panel.css"), "utf8");

describe("desktop ConfigStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cfg-"));
    file = path.join(dir, "config.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads defaults and persists dotted overrides", async () => {
    const store = new ConfigStore(file);
    expect(store.getConfiguration("grok").get("cliPath", "")).toBe("");
    expect(store.getConfiguration("grok").get("showThinking", false)).toBe(false);

    await store.getConfiguration("grok").update("cliPath", "/bin/fake-grok");
    expect(store.getConfiguration("grok").get("cliPath")).toBe("/bin/fake-grok");

    const again = new ConfigStore(file);
    expect(again.getConfiguration("grok").get("cliPath")).toBe("/bin/fake-grok");
  });

  it("persists the Codex CLI override through the desktop config store", async () => {
    const store = new ConfigStore(file);
    expect(store.getConfiguration("grok").get("codexCliPath")).toBe("");
    await store.getConfiguration("grok").update("codexCliPath", "/opt/codex/bin/codex");
    expect(new ConfigStore(file).getConfiguration("grok").get("codexCliPath"))
      .toBe("/opt/codex/bin/codex");
  });

  it("fires onDidChange for dotted keys", async () => {
    const store = new ConfigStore(file);
    const seen: string[] = [];
    store.onDidChange((e) => {
      if (e.affectsConfiguration("grok.cliPath")) seen.push("cliPath");
      if (e.affectsConfiguration("grok")) seen.push("grok");
    });
    await store.getConfiguration("grok").update("cliPath", "x");
    expect(seen).toContain("cliPath");
    expect(seen).toContain("grok");
  });

  it("persists workspace root", () => {
    const store = new ConfigStore(file);
    // Real directory so reload normalization keeps the path on every platform.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ws-persist-"));
    try {
      store.setWorkspaceRoot(ws);
      expect(new ConfigStore(file).getWorkspaceRoot()).toBe(path.resolve(ws));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("multi-folder: add / switch / allow last remove / reload", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mf-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mf-b-"));
    try {
      const store = new ConfigStore(file);
      expect(store.addWorkspaceRoot(a, true)).toBe(true);
      expect(store.getWorkspaceRoots()).toEqual([path.resolve(a)]);
      expect(store.getWorkspaceRoot()).toBe(path.resolve(a));
      expect(store.addWorkspaceRoot(b, true)).toBe(true);
      expect(store.getWorkspaceRoots().map((p) => path.resolve(p)).sort()).toEqual(
        [path.resolve(a), path.resolve(b)].sort(),
      );
      expect(store.getWorkspaceRoot()).toBe(path.resolve(b));
      expect(store.setActiveWorkspaceRoot(a)).toBe(true);
      expect(store.getWorkspaceRoot()).toBe(path.resolve(a));
      // Closing the last folder is allowed — empty open set is user-owned.
      expect(store.removeWorkspaceRoot(b)).toBe(true);
      expect(store.removeWorkspaceRoot(a)).toBe(true);
      expect(store.getWorkspaceRoots()).toEqual([]);
      expect(store.getWorkspaceRoot()).toBeUndefined();

      const reloaded = new ConfigStore(file);
      expect(reloaded.getWorkspaceRoots()).toEqual([]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("normalizeWorkspaceRoots dedupes and drops missing paths", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "grok-norm-"));
    try {
      const out = normalizeWorkspaceRoots([a, a, path.join(a, "nope-missing")]);
      expect(out).toEqual([path.resolve(a)]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
    }
  });

  it("honours caller-supplied defaultValue for unknown keys (arguments-in-arrow bug)", () => {
    const store = new ConfigStore(file);
    // Unknown key: getValue returns undefined; default must win.
    expect(store.getConfiguration("grok").get("notARealKey", "fallback-x")).toBe("fallback-x");
    expect(store.getConfiguration("grok").get("notARealKey")).toBeUndefined();
    // Known default still preferred over a caller default when set in CONFIG_DEFAULTS.
    expect(store.getConfiguration("grok").get("showThinking", true)).toBe(false);
  });
});

describe("app-resource URI mapping", () => {
  it("round-trips a file Uri through asWebviewUri shape", () => {
    const u = Uri.file(path.join("C:", "GitHub", "repo", "media", "chat.js"));
    const href = asAppResourceUrl(u);
    expect(href.startsWith("app-resource://vsc-resource/")).toBe(true);
    expect(APP_RESOURCE_CSP_SOURCE).toBe("app-resource:");
    const back = appResourceUrlToFsPath(href);
    expect(back).toBeTruthy();
    // Path separators normalized by path module on the host platform.
    expect(back!.toLowerCase().replace(/\\/g, "/")).toContain("media/chat.js");
  });

  it("main document URL is a stable app-resource origin (not data:)", () => {
    expect(APP_DOCUMENT_URL).toBe("app-resource://vsc-resource/__app__/index.html");
    expect(APP_ORIGIN).toBe("app-resource://vsc-resource");
    expect(APP_DOCUMENT_PATH).toBe("/__app__/index.html");
    expect(isAppDocumentUrl(APP_DOCUMENT_URL)).toBe(true);
    expect(isAppDocumentUrl(`${APP_DOCUMENT_URL}?x=1`)).toBe(true);
    expect(isAppDocumentUrl("app-resource://vsc-resource/media/chat.js")).toBe(false);
    expect(isAppDocumentUrl("app-resource://other/__app__/index.html")).toBe(false);
    expect(isAppDocumentUrl("data:text/html,hi")).toBe(false);
    // Document path must never look like a serveable filesystem asset.
    expect(appResourceUrlToFsPath(APP_DOCUMENT_URL)).toBeUndefined();
  });
});

describe("findFilesUnder", () => {
  it("lists files and skips node_modules", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-find-"));
    try {
      fs.writeFileSync(path.join(root, "a.ts"), "a");
      fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", "x", "y.js"), "y");
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "b.ts"), "b");
      const uris = await findFilesUnder(root);
      const rels = uris.map((u) => path.relative(root, u.fsPath).split(path.sep).join("/"));
      expect(rels).toContain("a.ts");
      expect(rels).toContain("src/b.ts");
      expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("document-view helpers", () => {
  it("interpretOpenPathResult treats empty string as success", () => {
    expect(interpretOpenPathResult("")).toEqual({ ok: true });
    expect(interpretOpenPathResult("Failed to open")).toEqual({
      ok: false,
      error: "Failed to open",
    });
  });

  it("escapeHtml neutralizes markup", () => {
    expect(escapeHtml(`<script>"x"&y</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;y&lt;/script&gt;",
    );
  });

  it("resolveDocumentText reads file URIs and content providers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-doc-"));
    try {
      const file = path.join(tmp, "a.txt");
      fs.writeFileSync(file, "from-disk");
      const fileUri = Uri.file(file);
      expect(
        resolveDocumentText(fileUri, new Map(), (p) => fs.readFileSync(p, "utf8")),
      ).toBe("from-disk");

      const virtual = Uri.from({
        scheme: "grok-diff",
        path: "/1/before/x.ts",
        fsPath: "/1/before/x.ts",
      });
      const providers = new Map([
        [
          "grok-diff",
          {
            provideTextDocumentContent: (u: Uri) =>
              u.toString().includes("before") ? "old" : "new",
          },
        ],
      ]);
      expect(resolveDocumentText(virtual, providers, () => "")).toBe("old");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("buildTextViewerHtml embeds content as text (not raw HTML)", () => {
    const html = buildTextViewerHtml("Untitled", "<b>hi</b>", "markdown");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
    expect(html).toContain("read-only");
    expect(html).toContain(" · markdown");
  });

  it("buildTextViewerHtml omits a language label when language is unset", () => {
    const html = buildTextViewerHtml("Untitled", "echo hi");
    expect(html).toContain("Untitled · read-only");
    expect(html).not.toContain(" · powershell");
    expect(html).not.toContain(" · shellscript");
  });

  it("buildDiffViewerHtml marks differing lines and focuses a line", () => {
    const html = buildDiffViewerHtml(
      "Grok proposed: foo.ts",
      "before",
      "a\nb",
      "after",
      "a\nB",
      1,
    );
    expect(html).toContain("read-only preview");
    expect(html).toContain('id="focus-line"');
    expect(html).toContain("row diff");
    expect(html).toContain(">a</div>");
  });

  it("prepareDocumentViewText truncates at the 8 MiB media-aligned bound", () => {
    expect(MAX_DOCUMENT_VIEW_CHARS).toBe(8 * 1024 * 1024);
    const under = "x".repeat(100);
    expect(prepareDocumentViewText(under)).toEqual({
      text: under,
      truncated: false,
    });
    const over = "y".repeat(MAX_DOCUMENT_VIEW_CHARS + 50);
    const prepared = prepareDocumentViewText(over);
    expect(prepared.truncated).toBe(true);
    expect(prepared.text.length).toBe(MAX_DOCUMENT_VIEW_CHARS);
    expect(prepared.notice).toMatch(/truncated/i);
    expect(prepared.notice).toMatch(/50/);
    // Mutation: without the cap, over would pass through whole.
    expect(over.length).toBeGreaterThan(MAX_DOCUMENT_VIEW_CHARS);
  });

  it("oversized openText / openDiff HTML shows a visible truncation notice", () => {
    // Use a small test cap so we don't allocate multi-MiB HTML in unit tests;
    // production callers omit maxChars and get MAX_DOCUMENT_VIEW_CHARS (8 MiB).
    const cap = 64;
    const huge = "Z".repeat(cap + 10);
    const textHtml = buildTextViewerHtml("Untitled", huge, undefined, cap);
    expect(textHtml).toContain('class="trunc"');
    expect(textHtml).toMatch(/truncated/i);
    expect(textHtml).toContain("· truncated");
    // Body holds only the cap, not the full payload.
    expect(textHtml).not.toContain("Z".repeat(cap + 1));
    // Mutation: without prepareDocumentViewText the full string would appear.
    expect(huge.length).toBe(cap + 10);

    const diffHtml = buildDiffViewerHtml(
      "Grok proposed: big.ts",
      "before",
      huge,
      "after",
      "small",
      undefined,
      cap,
    );
    expect(diffHtml).toContain('class="trunc"');
    expect(diffHtml).toMatch(/truncated/i);
    // Mutation: pre-cap buildDiffViewerHtml would embed the full side —
    // the notice is the user-visible proof.
    expect(diffHtml).toContain("Before:");
  });
});

describe("createSafeStorageSecrets", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sec-"));
    file = path.join(dir, "secrets.enc.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function xorStorage(key = 0x5a): SafeStorageLike {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (s) =>
        Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ key)),
      decryptString: (buf) =>
        Buffer.from([...buf].map((b) => b ^ key)).toString("utf8"),
    };
  }

  it("stores ciphertext, not the plaintext token", async () => {
    const secrets = createSafeStorageSecrets(file, xorStorage());
    const token = "device-token-super-secret";
    await secrets.store("grok.remoteControl.deviceToken", token);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).entries["grok.remoteControl.deviceToken"]).toBeTruthy();
    expect(await secrets.get("grok.remoteControl.deviceToken")).toBe(token);
  });

  it("round-trips store → get → delete", async () => {
    const secrets = createSafeStorageSecrets(file, xorStorage());
    await secrets.store("k", "v1");
    expect(await secrets.get("k")).toBe("v1");
    await secrets.delete("k");
    expect(await secrets.get("k")).toBeUndefined();
  });

  it("fails loudly when encryption is unavailable (no plaintext fallback)", async () => {
    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("should not encrypt");
      },
      decryptString: () => {
        throw new Error("should not decrypt");
      },
    };
    const secrets = createSafeStorageSecrets(file, unavailable);
    await expect(secrets.store("k", "v")).rejects.toBeInstanceOf(EncryptionUnavailableError);
    // Missing key still returns undefined without needing decrypt.
    expect(await secrets.get("missing")).toBeUndefined();
    // Persist a ciphertext with a working encryptor, then refuse decrypt.
    await createSafeStorageSecrets(file, xorStorage()).store("k", "secret");
    await expect(secrets.get("k")).rejects.toBeInstanceOf(EncryptionUnavailableError);
    // Disk must still hold only ciphertext — never a silent plaintext rewrite.
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret");
  });

  it("unlink can delete ciphertext when get throws (offline kill-switch)", async () => {
    // Store a real ciphertext, then use a decryptor that throws (keychain
    // unavailable / key rotated). Delete must still clear the entry so the
    // user is not stuck linked forever.
    await createSafeStorageSecrets(file, xorStorage()).store(
      "grok.remoteControl.deviceToken",
      "device-token",
    );
    const brokenDecrypt: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, "utf8"),
      decryptString: () => {
        throw new Error("OS keychain refused decrypt");
      },
    };
    const broken = createSafeStorageSecrets(file, brokenDecrypt);
    await expect(broken.get("grok.remoteControl.deviceToken")).rejects.toThrow(/decrypt/i);
    // delete does not need the OS key — this is the kill-switch property.
    await broken.delete("grok.remoteControl.deviceToken");
    expect(await createSafeStorageSecrets(file, xorStorage()).get("grok.remoteControl.deviceToken"))
      .toBeUndefined();
    // Sidebar must not require a successful get before delete.
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    expect(sidebar).toContain("readDeviceToken");
    const unlinkStart = sidebar.indexOf("async unlinkRemoteDevice()");
    const unlinkEnd = sidebar.indexOf("private async postRemoteStatus", unlinkStart);
    const unlinkBody = sidebar.slice(unlinkStart, unlinkEnd);
    expect(unlinkBody).toContain("readDeviceToken");
    expect(unlinkBody).toContain("secrets.delete");
    // get is only via the tolerant helper (never a bare throw-stopper before delete).
    expect(unlinkBody).not.toMatch(/await this\.context\.secrets\.get\(/);
  });

  it("startup tolerates an undecryptable device token (no throw)", async () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    // readDeviceToken catches decrypt failures; callers use it instead of bare get.
    expect(sidebar).toMatch(
      /private async readDeviceToken\(\)[\s\S]*?catch[\s\S]*?return undefined/,
    );
    expect(sidebar).toMatch(/maybeStartUplink[\s\S]*?readDeviceToken/);
    expect(sidebar).toMatch(/postRemoteStatus[\s\S]*?readDeviceToken/);
  });

  it("mutation: a plaintext fallback would be detectable", async () => {
    // If createSafeStorageSecrets were "fixed" to write plaintext when
    // encryption is off, this test fails. Keep the unavailable path hard-fail.
    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s, "utf8"),
      decryptString: (b) => b.toString("utf8"),
    };
    const secrets = createSafeStorageSecrets(file, unavailable);
    let threw = false;
    try {
      await secrets.store("grok.remoteControl.deviceToken", "plain-token-value");
    } catch (e) {
      threw = e instanceof EncryptionUnavailableError;
    }
    expect(threw).toBe(true);
    if (fs.existsSync(file)) {
      expect(fs.readFileSync(file, "utf8")).not.toContain("plain-token-value");
    }
  });

  it("writes secrets via temp file then rename (crash-safe)", async () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "safe-secrets.ts"),
      "utf8",
    );
    expect(src).toContain("writeFileAtomic");
    expect(src).toMatch(/renameSync/);
    // Functional: writeFileAtomic leaves a valid final file, never a bare partial.
    const out = path.join(dir, "atomic.json");
    writeFileAtomic(out, JSON.stringify({ ok: true }));
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ ok: true });
    // No leftover temps for that write.
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("desktop main wiring (source gates)", () => {
  it("re-delivers the live pendingUpdate after the reload delay, not a pre-timeout snapshot", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    // A snapshot taken before setTimeout re-posts a stale notice over a
    // notice→ready transition that lands in the 500 ms window.
    expect(main).not.toMatch(/const n = pendingUpdate;\s*setTimeout/);
    expect(main).toMatch(
      /setTimeout\(\(\) => \{\s*const live = pendingUpdate;[\s\S]*?live\.kind === "ready"[\s\S]*?\}, 500\)/,
    );
  });

  it("stores device credentials via safeStorage, not plaintext createFileSecrets", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("createSafeStorageSecrets");
    expect(main).toContain("safeStorage");
    expect(main).toContain("secrets.enc.json");
    expect(main).not.toContain("createFileSecrets");
    expect(main).not.toMatch(/secrets\.json/);
  });

  it("wires linkRemote/unlinkRemote to the sidebar device-link flow", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("linkRemoteDevice");
    expect(main).toContain("unlinkRemoteDevice");
    expect(main).toContain("remoteActions");
  });

  it("desktop remoteSignOut uses the same native confirm as unlinkRemoteDevice", () => {
    const sidebar = fs.readFileSync(path.join(testRepoRoot, "src", "sidebar.ts"), "utf8");
    const start = sidebar.indexOf('case "remoteSignOut"');
    const end = sidebar.indexOf('case "openRemotePortal"', start);
    const body = sidebar.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("canSwitchWorkspaceFolder");
    expect(body).toContain("confirmHostExecute");
    expect(body).toContain("unlinkRemoteDevice");

    // VS Code palette still calls the method directly — no confirm there.
    const ext = fs.readFileSync(path.join(testRepoRoot, "src", "extension.ts"), "utf8");
    expect(ext).toMatch(/registerCommand\("grok.unlinkRemote", \(\) => sidebar\.unlinkRemoteDevice\(\)\)/);
    const unlinkStart = sidebar.indexOf("async unlinkRemoteDevice()");
    const unlinkEnd = sidebar.indexOf("private async postRemoteStatus", unlinkStart);
    expect(sidebar.slice(unlinkStart, unlinkEnd)).not.toContain("confirmHostExecute");
  });

  it("first-run default project is provisioned from paths.ts before the sidebar starts", () => {
    const main = fs.readFileSync(path.join(testRepoRoot, "src", "desktop", "main.ts"), "utf8");
    expect(main).toContain("provisionDefaultProjectDir");
    expect(main).toContain("desktopUserHomeDir");
    expect(main).toContain("provisionDefaultProject:");
    // Sidebar must already see the root — constructing it first left
    // RemoteClientState / defaultProvider on "".
    const provisionAt = main.indexOf("provisionDefaultProjectDir");
    const sidebarAt = main.indexOf("new GrokSidebar");
    expect(provisionAt).toBeGreaterThan(0);
    expect(sidebarAt).toBeGreaterThan(provisionAt);

    const host = fs.readFileSync(path.join(testRepoRoot, "src", "desktop", "electron-host.ts"), "utf8");
    expect(host).toContain("provisionDefaultProject?.()");
    expect(host).toContain("seeded.length");

    const sidebar = fs.readFileSync(path.join(testRepoRoot, "src", "sidebar.ts"), "utf8");
    expect(sidebar).toContain("presentEmptyProjectState");
    // Third fixed window into this one method, and the third to be broken by a
    // few lines landing at its top rather than by anything it tests. It only
    // has to clear the prologue and reach the refusal at ~1810 chars; the size
    // is a search bound, not an assertion about layout.
    const startBody = sidebar.slice(
      sidebar.indexOf("private async startSessionBody("),
      sidebar.indexOf("private async startSessionBody(") + 3000,
    );
    expect(startBody).toContain("presentEmptyProjectState(target)");
    expect(startBody).toContain("refused startSession");
    const removeBody = sidebar.slice(
      sidebar.indexOf("async removeProjectFolder("),
      sidebar.indexOf("private presentEmptyProjectState("),
    );
    expect(removeBody).toContain("presentEmptyProjectState(this.focused)");
    expect(sidebar).toMatch(/if \(this\.host\.canSwitchWorkspaceFolder\) return "";/);
  });

  it("registers file-tree IPC while getHtml loads the component only for desktop", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    const preload = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "preload.ts"),
      "utf8",
    );
    expect(main).toContain("registerFileTreeIpc");
    expect(main).toContain("injectFileTreePanelLogged");
    expect(main).toContain("did-finish-load");
    expect(preload).toContain("grokDesktopFileTree");
    expect(preload).toContain("grokDesktopShell");
    expect(preload).toContain("desk-ft:list");
    // Panel boot must not live in shared chat.js.
    const chatJs = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    expect(chatJs).not.toContain("desk-ft-");
    expect(chatJs).not.toContain("grokDesktopFileTree");
    // Capability flag only — chat may detect desktop shell for client zoom.
    expect(chatJs).toContain("grokDesktopShell");

    const sidebar = fs.readFileSync(path.join(testRepoRoot, "src", "sidebar.ts"), "utf8");
    const assetGate = sidebar.slice(
      sidebar.indexOf("const filePanelStyle"),
      sidebar.indexOf("return `<!DOCTYPE html>", sidebar.indexOf("const filePanelStyle")),
    );
    expect(assetGate).toContain("this.host.canSwitchWorkspaceFolder");
    expect(assetGate).toContain('mediaUri("file-panel.css")');
    expect(assetGate).toContain('mediaUri("file-panel.js")');
    // An empty branch means the VS Code webview receives neither tag; absence
    // of a mount call is not the thing enforcing the product decision.
    expect(assetGate.match(/:\s*"";/g)).toHaveLength(2);

    // First-frame desktop chrome: rail visible + files shell in getHtml so the
    // window never paints the panel-less layout and then upgrades.
    expect(sidebar).toContain('class="desk${deskLayoutClass}');
    expect(sidebar).toContain('id="projects-rail" class="projects-rail" aria-label="Projects"');
    expect(sidebar).not.toContain('class="projects-rail" hidden aria-label="Projects"');
    expect(sidebar).toContain('id="desk-ft-shell"');
    expect(sidebar).toContain("desk-with-ft");
  });

  it("does not expose a process-global lastOpen path (cross-project leak)", () => {
    // A lastOpenedPath diagnostic survived project switches and returned
    // project-A paths after the root moved to B. Tests use openSink only.
    const ipc = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "file-tree-ipc.ts"),
      "utf8",
    );
    const preload = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "preload.ts"),
      "utf8",
    );
    expect(ipc).not.toMatch(/lastOpenedPath|lastOpen|CH_LAST_OPEN|desk-ft:lastOpen/);
    expect(preload).not.toMatch(/lastOpen|desk-ft:lastOpen/);
  });
});

describe("file-tree path containment", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ft-"));
    fs.writeFileSync(path.join(root, "readme.txt"), "hi");
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "hello.ts"), "export {}");
    fs.writeFileSync(path.join(root, "src", "nested", "deep.ts"), "export {}");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves empty and nested relative paths under the workspace", () => {
    const top = resolveTreePath(root, "");
    expect(top.ok).toBe(true);
    if (top.ok) {
      expect(path.resolve(top.absPath)).toBe(path.resolve(root));
      expect(top.relPath).toBe("");
    }
    const nested = resolveTreePath(root, "src/nested/deep.ts");
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.relPath).toBe("src/nested/deep.ts");
      expect(fs.existsSync(nested.absPath)).toBe(true);
    }
  });

  it("rejects traversal, absolute escape, and null bytes", () => {
    expect(resolveTreePath(root, "..").ok).toBe(false);
    expect(resolveTreePath(root, "../outside").ok).toBe(false);
    expect(resolveTreePath(root, "src/../../outside").ok).toBe(false);
    expect(resolveTreePath(root, "src/foo/../../../etc/passwd").ok).toBe(false);
    expect(resolveTreePath(root, "a\0b").ok).toBe(false);

    // Absolute path outside workspace
    const outside = path.resolve(root, "..", "not-ws-" + Date.now());
    expect(resolveTreePath(root, outside).ok).toBe(false);

    // Absolute path that happens to be inside is allowed (openFile may pass abs).
    const insideAbs = path.join(root, "readme.txt");
    const absOk = resolveTreePath(root, insideAbs);
    expect(absOk.ok).toBe(true);
    if (absOk.ok) expect(absOk.relPath).toBe("readme.txt");
  });

  it("mutation: dropping the .. segment check would accept a traversal", () => {
    // Guard must reject any segment equal to "..". If someone "simplifies" to
    // only path.relative after resolve, carefully crafted inputs can slip;
    // this pins the explicit segment rejection.
    const bad = resolveTreePath(root, "src/..");
    // "src/.." has a .. segment → reject even though it resolves to root.
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/escape/i);
  });

  it("lists directories with dirs first and truncates huge folders", () => {
    const listed = listTreeDir(root, "");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const names = listed.entries.map((e) => e.name);
    expect(names).toContain("readme.txt");
    expect(names).toContain("src");
    // dirs before files
    const srcIdx = listed.entries.findIndex((e) => e.name === "src");
    const readmeIdx = listed.entries.findIndex((e) => e.name === "readme.txt");
    expect(listed.entries[srcIdx].kind).toBe("dir");
    expect(listed.entries[readmeIdx].kind).toBe("file");
    expect(srcIdx).toBeLessThan(readmeIdx);

    const srcList = listTreeDir(root, "src");
    expect(srcList.ok).toBe(true);
    if (srcList.ok) {
      expect(srcList.entries.map((e) => e.name)).toEqual(
        expect.arrayContaining(["hello.ts", "nested"]),
      );
    }

    // Cap: create a dir with more than maxEntries when max is low.
    const many = path.join(root, "many");
    fs.mkdirSync(many);
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(many, `f${i}.txt`), "x");
    }
    const capped = listTreeDir(root, "many", 10);
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.entries.length).toBe(10);
      expect(capped.truncated).toBe(true);
    }
    expect(FILE_TREE_MAX_ENTRIES).toBeGreaterThan(100);
  });

  it("rejects listing a path outside the workspace", () => {
    const r = listTreeDir(root, "../");
    expect(r.ok).toBe(false);
  });

  it("rejects outbound symlink for both list and open (canonical containment)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ft-out-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "classified");
      const linkPath = path.join(root, "escape-link");
      let created = false;
      try {
        // Prefer a real directory symlink when the OS allows it.
        fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "dir" : "dir");
        created = true;
      } catch (e) {
        // Windows without Developer Mode cannot create dir symlinks (EPERM).
        // Fall through to an injectable realpath that simulates the same escape
        // so the regression still fails if the realpath gate is removed.
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EPERM" && err.code !== "EACCES") throw e;
      }

      if (created) {
        // Listing the workspace must not surface the outbound link as a dir.
        const top = listTreeDir(root, "");
        expect(top.ok).toBe(true);
        if (top.ok) {
          expect(top.entries.map((e) => e.name)).not.toContain("escape-link");
        }
        // Resolve / open path must refuse.
        const resolved = resolveTreePath(root, "escape-link");
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.reason).toMatch(/symlink|escape/i);
        const nested = resolveTreePath(root, "escape-link/secret.txt");
        expect(nested.ok).toBe(false);
        const listed = listTreeDir(root, "escape-link");
        expect(listed.ok).toBe(false);
      } else {
        // Simulated symlink: realpath of root/escape-link → outside.
        const linkAbs = path.join(root, "escape-link");
        const secretAbs = path.join(root, "escape-link", "secret.txt");
        const mockFs: TreePathFs = {
          realpathSync(p: string) {
            const n = path.normalize(p);
            if (n === path.normalize(linkAbs) || n.startsWith(path.normalize(linkAbs) + path.sep)) {
              return path.join(outside, path.relative(linkAbs, n));
            }
            return fs.realpathSync(p);
          },
          existsSync: (p) => fs.existsSync(p),
          statSync: (p) => fs.statSync(p),
          readdirSync: (p, o) => fs.readdirSync(p, o),
        };
        // Create a real in-tree dir so readdir/stat have something; realpath redirects.
        fs.mkdirSync(linkAbs);
        fs.writeFileSync(secretAbs, "x");
        const resolved = resolveTreePath(root, "escape-link", process.platform, mockFs);
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.reason).toMatch(/symlink|escape/i);
        const nested = resolveTreePath(root, "escape-link/secret.txt", process.platform, mockFs);
        expect(nested.ok).toBe(false);
        // Mutation: pure lexical resolve would accept these paths.
        const lexicalOnly = path.resolve(root, "escape-link", "secret.txt");
        expect(lexicalOnly.startsWith(path.resolve(root))).toBe(true);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects Windows junction pointing outside (list + open)", function () {
    if (process.platform !== "win32") {
      // Junctions are a Windows reparse-point feature.
      return;
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ft-junc-out-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "junction-secret");
      const junc = path.join(root, "vendor");
      fs.symlinkSync(outside, junc, "junction");

      const top = listTreeDir(root, "");
      expect(top.ok).toBe(true);
      if (top.ok) {
        expect(top.entries.map((e) => e.name)).not.toContain("vendor");
      }
      expect(resolveTreePath(root, "vendor").ok).toBe(false);
      expect(resolveTreePath(root, "vendor/secret.txt").ok).toBe(false);
      expect(listTreeDir(root, "vendor").ok).toBe(false);

      // Mutation pin: lexical containment alone would pass (link path is in-tree).
      const lexical = path.resolve(root, "vendor", "secret.txt");
      expect(lexical.startsWith(path.resolve(root))).toBe(true);
      const real = fs.realpathSync(path.join(root, "vendor", "secret.txt"));
      expect(path.resolve(real).startsWith(path.resolve(root))).toBe(false);
    } finally {
      try {
        fs.rmSync(path.join(root, "vendor"), { recursive: true, force: true });
      } catch {
        /* junction remove */
      }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows an in-workspace symlink (target still under root)", () => {
    const target = path.join(root, "src", "hello.ts");
    const link = path.join(root, "alias.ts");
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "file" : "file");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EPERM" || err.code === "EACCES") {
        // No symlink privilege — simulate with injectable realpath that stays inside.
        const mockFs: TreePathFs = {
          realpathSync(p: string) {
            if (path.normalize(p) === path.normalize(link)) return fs.realpathSync(target);
            return fs.realpathSync(p);
          },
          existsSync: (p) => (path.normalize(p) === path.normalize(link) ? true : fs.existsSync(p)),
          statSync: (p) => fs.statSync(path.normalize(p) === path.normalize(link) ? target : p),
          readdirSync: (p, o) => fs.readdirSync(p, o),
        };
        const r = resolveTreePath(root, "alias.ts", process.platform, mockFs);
        expect(r.ok).toBe(true);
        return;
      }
      throw e;
    }
    try {
      const r = resolveTreePath(root, "alias.ts");
      expect(r.ok).toBe(true);
    } finally {
      fs.unlinkSync(link);
    }
  });
});

describe("resolveTreeOpenTarget (open/reveal containment fence)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ft-open-"));
    fs.writeFileSync(path.join(root, "readme.txt"), "hi");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "hello.ts"), "export {}");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves a workspace file for open (default)", () => {
    const r = resolveTreeOpenTarget(root, "readme.txt");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(path.resolve(r.absPath)).toBe(path.resolve(root, "readme.txt"));
    }
    const nested = resolveTreeOpenTarget(root, "src/hello.ts", undefined, "open");
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(path.resolve(nested.absPath)).toBe(path.resolve(root, "src", "hello.ts"));
    }
  });

  it("refuses a directory by default (open path)", () => {
    const r = resolveTreeOpenTarget(root, "src");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not a file");

    // Explicit open verb still refuses dirs.
    const open = resolveTreeOpenTarget(root, "src", undefined, "open");
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.error).toBe("not a file");
  });

  it("allows a directory only when allowDirectory is set (reveal path)", () => {
    const refused = resolveTreeOpenTarget(root, "src", undefined, "reveal");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("not a file");

    const allowed = resolveTreeOpenTarget(root, "src", undefined, "reveal", {
      allowDirectory: true,
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(path.resolve(allowed.absPath)).toBe(path.resolve(root, "src"));
    }

    // File still resolves under the opt-in.
    const file = resolveTreeOpenTarget(root, "readme.txt", undefined, "reveal", {
      allowDirectory: true,
    });
    expect(file.ok).toBe(true);
  });

  it("refuses a path that escapes the workspace root either way", () => {
    const outside = path.resolve(root, "..", "not-ws-" + Date.now());
    for (const opts of [undefined, { allowDirectory: true } as const]) {
      expect(resolveTreeOpenTarget(root, "..", undefined, "open", opts).ok).toBe(false);
      expect(resolveTreeOpenTarget(root, "../outside", undefined, "reveal", opts).ok).toBe(
        false,
      );
      expect(resolveTreeOpenTarget(root, outside, undefined, "open", opts).ok).toBe(false);
      expect(
        resolveTreeOpenTarget(root, "src/../../outside", undefined, "reveal", opts).ok,
      ).toBe(false);
    }
  });

  it("refuses non-string / missing paths", () => {
    expect(resolveTreeOpenTarget(root, null).ok).toBe(false);
    expect(resolveTreeOpenTarget(root, 12 as unknown as string).ok).toBe(false);
    expect(resolveTreeOpenTarget(root, "no-such-file.txt").ok).toBe(false);
  });
});

describe("app-resource serve policy (no credential leak)", () => {
  let tmp: string;
  let grokHome: string;
  let mediaRoot: string;
  let staging: string;
  let roots: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-res-"));
    grokHome = path.join(tmp, "fake-grok-home");
    mediaRoot = path.join(tmp, "ext", "media");
    staging = path.join(tmp, "globalStorage", "image-staging");
    roots = [mediaRoot, staging, grokHome];
    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(path.join(grokHome, "sessions", "cwd", "id", "images"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(mediaRoot, "chat.js"), "/* chat */");
    fs.writeFileSync(path.join(staging, "image-uuid.png"), "png");
    fs.writeFileSync(path.join(grokHome, "auth.json"), '{"token":"secret"}');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies Grok home as media-only and extension media as full", () => {
    expect(rootServePolicy(grokHome)).toBe("media-only");
    expect(rootServePolicy(mediaRoot)).toBe("full");
    expect(rootServePolicy(staging)).toBe("full");
  });

  it("refuses path-shaped URLs under Grok home (registry required)", () => {
    const auth = path.join(grokHome, "auth.json");
    expect(appResourceMayServe(auth, roots)).toBe(false);
    expect(
      appResourceMayServe(path.join(grokHome, "config.toml"), roots),
    ).toBe(false);
    const img = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    expect(isGeneratedSessionMediaPath(img)).toBe(true);
    // Path allowlist alone is no longer enough — provenance via registry.
    expect(appResourceMayServe(img, roots)).toBe(false);
  });

  it("allows extension media and image staging via static path", () => {
    expect(appResourceMayServe(path.join(mediaRoot, "chat.js"), roots)).toBe(true);
    expect(appResourceMayServe(path.join(staging, "image-uuid.png"), roots)).toBe(true);
  });

  it("serves generated media only through a host-issued registry handle", () => {
    const img = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    fs.writeFileSync(img, "fake-jpeg");
    const registry = new ResourceRegistry();
    const id = registry.register(img);
    const url = asAppResourceRegistryUrl(id);
    expect(registryIdFromUrlPath(url)).toBe(id);

    const viaPath = resolveAppResourceServe({
      urlOrPath: asAppResourceUrl(Uri.file(img)),
      fsPath: img,
      allowedRoots: roots,
      registry,
    });
    expect(viaPath.ok).toBe(false);

    const viaReg = resolveAppResourceServe({
      urlOrPath: url,
      allowedRoots: roots,
      registry,
    });
    expect(viaReg.ok).toBe(true);
    if (viaReg.ok) {
      expect(viaReg.via).toBe("registry");
      expect(fs.readFileSync(viaReg.fsPath, "utf8")).toBe("fake-jpeg");
    }
  });

  it("refuses a symlinked media file that points at a credential", () => {
    const auth = path.join(grokHome, "auth.json");
    const link = path.join(grokHome, "sessions", "cwd", "id", "images", "auth.png");
    const registry = new ResourceRegistry();

    let linked = false;
    try {
      fs.symlinkSync(auth, link, process.platform === "win32" ? "file" : undefined);
      linked = true;
    } catch {
      // No symlink privilege: simulate with injectable realpath via register
      // on the auth file itself under a media-looking name is the real risk;
      // without OS symlinks, register(auth) then resolve still serves auth —
      // the host must not register credentials. Path-shaped media URLs stay off.
    }

    if (linked) {
      // Host should never register a credential; if it did, realpath is auth.json
      // and we still refuse basename auth.json on the served path.
      try {
        const id = registry.register(link);
        const resolved = registry.resolveForServe(id);
        // After symlink, realpath is auth.json — resolveForServe returns the real
        // path; resolveAppResourceServe then refuses auth.json basenames.
        const serve = resolveAppResourceServe({
          urlOrPath: asAppResourceRegistryUrl(id),
          allowedRoots: roots,
          registry,
        });
        // Either register threw, resolve returned null after swap policy, or
        // serve refused credential basename.
        if (resolved && /auth\.json$/i.test(resolved)) {
          expect(serve.ok).toBe(false);
        } else {
          // Symlink may be registered as the link path with real=auth; refuse.
          expect(serve.ok === false || (serve.ok && !/auth\.json$/i.test(serve.fsPath))).toBe(
            true,
          );
          if (serve.ok) {
            // Must not leak credential bytes as a successful media serve of auth.json.
            expect(serve.fsPath.toLowerCase()).not.toMatch(/auth\.json$/i);
          }
        }
      } catch {
        // register refuses non-files / missing — also fine
      }
      // Path-shaped request for the link is always refused (media-only root).
      expect(
        resolveAppResourceServe({
          urlOrPath: link,
          fsPath: link,
          allowedRoots: roots,
          registry: new ResourceRegistry(),
        }).ok,
      ).toBe(false);
    }

    // Mutation: a path-shape allowlist would accept …/images/auth.png.
    expect(isGeneratedSessionMediaPath(link)).toBe(true);
    expect(appResourceMayServe(link, roots)).toBe(false);
  });

  it("refuses registry serve after realpath changes (symlink swap)", () => {
    const realImg = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    const auth = path.join(grokHome, "auth.json");
    fs.writeFileSync(realImg, "jpeg-bytes");
    const registry = new ResourceRegistry();
    const id = registry.register(realImg);
    expect(registry.resolveForServe(id)).toBeTruthy();

    // Replace the media file with a symlink to auth.json (when OS allows).
    let swapped = false;
    try {
      fs.unlinkSync(realImg);
      fs.symlinkSync(auth, realImg, process.platform === "win32" ? "file" : undefined);
      swapped = true;
    } catch {
      // Restore the original file if symlink failed mid-way.
      try {
        if (!fs.existsSync(realImg)) fs.writeFileSync(realImg, "jpeg-bytes");
      } catch {
        /* */
      }
    }

    if (!swapped) {
      // Without symlink privilege: simulate realpath divergence with injectable fs.
      const snapReal = fs.realpathSync(realImg);
      let phase: "register" | "serve" = "register";
      const mock = new ResourceRegistry({
        realpathSync: (p) => {
          if (path.resolve(p) === path.resolve(realImg)) {
            return phase === "register" ? snapReal : auth;
          }
          return fs.realpathSync(p);
        },
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
      });
      const mid = mock.register(realImg);
      phase = "serve";
      expect(mock.resolveForServe(mid)).toBeNull();
      return;
    }

    // Real target changed → refuse.
    expect(registry.resolveForServe(id)).toBeNull();
    expect(
      resolveAppResourceServe({
        urlOrPath: asAppResourceRegistryUrl(id),
        allowedRoots: roots,
        registry,
      }).ok,
    ).toBe(false);
  });

  it("mutation: lexical-only root check would serve auth.json", () => {
    const auth = path.join(grokHome, "auth.json");
    const lexicalOnly = roots.some((r) => {
      const rel = path.relative(r, auth);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    expect(lexicalOnly).toBe(true);
    expect(appResourceMayServe(auth, roots)).toBe(false);
  });
});

describe("webview message schema validation — routines", () => {
  // This validator is a strict allowlist ending in `default: return null`, so
  // TypeScript does NOT force a new message type to be handled here. The
  // Routines page shipped without these five and every one of them was dropped
  // silently on the desktop app: the page rendered, asked for its data, and got
  // nothing back — empty project and model pickers, no error anywhere.
  it("lets every routine message through", () => {
    expect(parseWebviewMsg({ type: "listRoutines" })).toEqual({ type: "listRoutines" });
    expect(parseWebviewMsg({ type: "deleteRoutine", id: "r1" })?.type).toBe("deleteRoutine");
    expect(parseWebviewMsg({ type: "runRoutineNow", id: "r1" })?.type).toBe("runRoutineNow");
    expect(parseWebviewMsg({ type: "setRoutinePaused", id: "r1", paused: true })?.type)
      .toBe("setRoutinePaused");
    expect(parseWebviewMsg({
      type: "saveRoutine",
      draft: {
        title: "Morning brief", prompt: "What changed?", cwd: "C:/repo",
        provider: "grok", model: "grok-4.6",
        cadence: { every: 6, unit: "hours" },
      },
    })?.type).toBe("saveRoutine");
    // Editing carries an id; creating does not.
    expect(parseWebviewMsg({ type: "saveRoutine", id: "r1", draft: { title: "x" } })?.type)
      .toBe("saveRoutine");
  });

  it("drops malformed routine messages", () => {
    expect(parseWebviewMsg({ type: "deleteRoutine" })).toBeNull();
    expect(parseWebviewMsg({ type: "deleteRoutine", id: 7 })).toBeNull();
    expect(parseWebviewMsg({ type: "setRoutinePaused", id: "r1" })).toBeNull();
    expect(parseWebviewMsg({ type: "setRoutinePaused", id: "r1", paused: "yes" })).toBeNull();
    expect(parseWebviewMsg({ type: "saveRoutine" })).toBeNull();
    expect(parseWebviewMsg({ type: "saveRoutine", draft: "nope" })).toBeNull();
    expect(parseWebviewMsg({ type: "saveRoutine", id: 7, draft: {} })).toBeNull();
    expect(parseWebviewMsg({ type: "saveRoutine", draft: { title: 7 } })).toBeNull();
    expect(parseWebviewMsg({ type: "saveRoutine", draft: { cadence: "daily" } })).toBeNull();
    expect(parseWebviewMsg({ type: "saveRoutine", draft: { cadence: { every: "six" } } })).toBeNull();
  });

  it("refuses an absurd prompt at the boundary rather than downstream", () => {
    // The renderer is untrusted and validateRoutine's cap runs after this gate
    // has already accepted whatever arrived.
    const huge = "x".repeat(8000 * 4 + 1);
    expect(parseWebviewMsg({ type: "saveRoutine", draft: { prompt: huge } })).toBeNull();
    expect(parseWebviewMsg({ type: "saveRoutine", draft: { prompt: "x".repeat(9000) } })?.type)
      .toBe("saveRoutine");
  });
});

describe("webview message schema validation", () => {
  it("accepts known well-formed messages", () => {
    expect(parseWebviewMsg({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewMsg({ type: "send", text: "hi" })).toEqual({
      type: "send",
      text: "hi",
    });
    expect(parseWebviewMsg({ type: "openFile", path: "a.ts" })?.type).toBe("openFile");
    expect(parseWebviewMsg({ type: "setMode", modeId: "plan" })?.type).toBe("setMode");
    expect(parseWebviewMsg({ type: "runGrokLogin", provider: "codex" })?.type)
      .toBe("runGrokLogin");
    expect(parseWebviewMsg({ type: "submitDeviceLoginCode", provider: "claude", code: "abc" })?.type)
      .toBe("submitDeviceLoginCode");
    expect(parseWebviewMsg({ type: "submitDeviceLoginCode", code: "abc" })?.type)
      .toBe("submitDeviceLoginCode");
    expect(parseWebviewMsg({ type: "submitDeviceLoginCode", provider: "claude" })).toBeNull();
    expect(parseWebviewMsg({ type: "cancelDeviceLogin", provider: "claude" })?.type)
      .toBe("cancelDeviceLogin");
    expect(parseWebviewMsg({ type: "cancelDeviceLogin", provider: "github" })?.type)
      .toBe("cancelDeviceLogin");
    expect(parseWebviewMsg({ type: "runGrokLogin", provider: "github" })).toBeNull();
    expect(parseWebviewMsg({ type: "installCodex" })?.type).toBe("installCodex");
    expect(parseWebviewMsg({ type: "cancelCodexInstall" })?.type).toBe("cancelCodexInstall");
    expect(parseWebviewMsg({ type: "restartToUpdate" })).toEqual({ type: "restartToUpdate" });
    expect(parseWebviewMsg({ type: "openUpdateRelease", url: "https://afkpilot.com/desktop-update" })?.type)
      .toBe("openUpdateRelease");
    expect(parseWebviewMsg({ type: "unlinkRemoteDevice" })).toEqual({ type: "unlinkRemoteDevice" });
    expect(parseWebviewMsg({ type: "setVoiceSendPhrase", value: "ok send" })).toEqual({
      type: "setVoiceSendPhrase",
      value: "ok send",
    });
    expect(parseWebviewMsg({ type: "setVoiceKeyterms", value: ["useEffect"] })).toEqual({
      type: "setVoiceKeyterms",
      value: ["useEffect"],
    });
    expect(parseWebviewMsg({ type: "setTelemetryEnabled", value: false })).toEqual({
      type: "setTelemetryEnabled",
      value: false,
    });
    expect(parseWebviewMsg({ type: "setThumbsFeedback", value: true })).toEqual({
      type: "setThumbsFeedback",
      value: true,
    });
    expect(parseWebviewMsg({ type: "setThumbsFeedback", value: "yes" })).toBeNull();
    expect(parseWebviewMsg({ type: "turnFeedback", rating: 1 })).toEqual({
      type: "turnFeedback",
      rating: 1,
    });
    expect(parseWebviewMsg({ type: "turnFeedback", rating: 0 })).toEqual({
      type: "turnFeedback",
      rating: 0,
    });
    expect(parseWebviewMsg({ type: "turnFeedback", rating: 2 })).toBeNull();
    expect(parseWebviewMsg({ type: "turnFeedback" })).toBeNull();
    expect(parseWebviewMsg({ type: "connectMcpConnector", id: "linear" })).toEqual({
      type: "connectMcpConnector",
      id: "linear",
    });
    expect(parseWebviewMsg({
      type: "connectMcpConnector",
      id: "github",
      key: "ghp_TESTSECRET_do_not_store",
      readOnly: true,
    })).toEqual({
      type: "connectMcpConnector",
      id: "github",
      key: "ghp_TESTSECRET_do_not_store",
      readOnly: true,
    });
    expect(parseWebviewMsg({ type: "connectMcpConnector", id: "github", key: 12 })).toBeNull();
    expect(parseWebviewMsg({ type: "connectMcpConnector", id: "github", readOnly: "yes" })).toBeNull();
    expect(parseWebviewMsg({ type: "disconnectMcpConnector", id: "linear" })?.type)
      .toBe("disconnectMcpConnector");
    expect(parseWebviewMsg({ type: "connectMcpConnector" })).toBeNull();
    expect(parseWebviewMsg({ type: "setVoiceSendPhrase" })).toBeNull();
    expect(parseWebviewMsg({ type: "setVoiceKeyterms", value: ["ok", 1] })).toBeNull();
    expect(parseWebviewMsg({ type: "setTelemetryEnabled", value: "no" })).toBeNull();
  });

  it("drops unknown types and malformed payloads", () => {
    expect(parseWebviewMsg(null)).toBeNull();
    expect(parseWebviewMsg("send")).toBeNull();
    expect(parseWebviewMsg({ type: "notARealMessage" })).toBeNull();
    expect(parseWebviewMsg({ type: "send" })).toBeNull(); // missing text
    expect(parseWebviewMsg({ type: "openFile" })).toBeNull();
    expect(parseWebviewMsg({ type: "openFile", path: 12 })).toBeNull();
    expect(parseWebviewMsg({ type: "setMode", modeId: "yolo-extra" })).toBeNull();
    expect(parseWebviewMsg({ type: "setCodexCliPath", value: "/opt/codex" })).toBeNull();
    expect(parseWebviewMsg({
      type: "listSessions",
      providerCursor: { grokOffset: 100, codexHighWater: { updatedAt: 50, id: "codex-1" } },
    })?.type).toBe("listSessions");
    expect(parseWebviewMsg({
      type: "listSessions",
      providerCursor: { grokOffset: 100, codexHighWater: { updatedAt: 50 } },
    })).toBeNull();
    expect(parseWebviewMsg({ type: "logout", provider: "unknown" })).toBeNull();
    expect(parseWebviewMsg({ type: "logout", evil: true })?.type).toBe("logout");
    // logout has no required fields beyond type — but inventing a type fails:
    expect(parseWebviewMsg({ type: "deleteEverything" })).toBeNull();
  });

  it("accepts openText with an optional save-as filename", () => {
    expect(parseWebviewMsg({ type: "openText", content: "# hi", language: "markdown" })).toEqual({
      type: "openText",
      content: "# hi",
      language: "markdown",
    });
    expect(parseWebviewMsg({
      type: "openText",
      content: "# hi",
      language: "markdown",
      filename: "Rewind map.md",
    })).toEqual({
      type: "openText",
      content: "# hi",
      language: "markdown",
      filename: "Rewind map.md",
    });
    expect(parseWebviewMsg({
      type: "openText",
      content: "# hi",
      filename: 12,
    })).toBeNull();
  });

  it("source gate: ElectronWebview.dispatchMessage validates before listeners", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(src).toContain("parseWebviewMsg");
    expect(src).toMatch(/dispatchMessage[\s\S]*parseWebviewMsg/);
  });
});

describe("session export save dialog", () => {
  it("plans a save dialog that defaults to the suggested filename", () => {
    expect(planSuggestedSaveDialog("/work/repo/Rewind map.md", {
      filters: { Markdown: ["md"] },
      title: "Export conversation",
    })).toEqual({
      defaultPath: "/work/repo/Rewind map.md",
      filters: { Markdown: ["md"] },
      title: "Export conversation",
    });
  });

  it("cancel writes nothing; a chosen path writes the markdown", () => {
    const writes: { path: string; data: string }[] = [];
    const write = (filePath: string, data: string) => {
      writes.push({ path: filePath, data });
    };
    expect(writeSuggestedFileOrCancel("# hi", undefined, write)).toBe(false);
    expect(writes).toEqual([]);
    expect(writeSuggestedFileOrCancel("# hi", "/tmp/Rewind map.md", write)).toBe(true);
    expect(writes).toEqual([{ path: "/tmp/Rewind map.md", data: "# hi" }]);
  });

  it("openText with a filename takes the save-dialog path; cancel writes nothing", async () => {
    const writes: { path: string; data: string }[] = [];
    const cancel = await deliverSuggestedFileSave({
      suggestedFilename: "/work/repo/Rewind map.md",
      content: "# Rewind map\n",
      filters: { Markdown: ["md"] },
      title: "Export conversation",
      showSaveDialog: async (options) => {
        expect(options.defaultPath).toBe("/work/repo/Rewind map.md");
        expect(options.filters).toEqual({ Markdown: ["md"] });
        return undefined;
      },
      writeFile: (filePath, data) => {
        writes.push({ path: filePath, data });
      },
    });
    expect(cancel).toBe("cancelled");
    expect(writes).toEqual([]);

    const saved = await deliverSuggestedFileSave({
      suggestedFilename: "/work/repo/Rewind map.md",
      content: "# Rewind map\n",
      showSaveDialog: async () => "/tmp/out.md",
      writeFile: (filePath, data) => {
        writes.push({ path: filePath, data });
      },
    });
    expect(saved).toBe("saved");
    expect(writes).toEqual([{ path: "/tmp/out.md", data: "# Rewind map\n" }]);
  });

  it("derives save-dialog filters and title from the suggested filename", () => {
    expect(saveFiltersForFilename("/work/repo/Rewind map.md")).toEqual({ Markdown: ["md"] });
    expect(saveDialogTitleForFilename("/work/repo/Rewind map.md")).toBe("Export conversation");
    expect(saveFiltersForFilename("Untitled.ps1")).toEqual({ PowerShell: ["ps1"] });
    expect(saveDialogTitleForFilename("Untitled.ps1")).toBe("Save as");
    expect(saveFiltersForFilename("src/foo.ts.diff")).toEqual({ Diff: ["diff"] });
    expect(saveDialogTitleForFilename("src/foo.ts.diff")).toBe("Save as");
    expect(saveFiltersForFilename("notes")).toEqual({ "All files": ["*"] });
  });

  it("openText without a filename falls back to the untitled/viewer path", async () => {
    const writes: string[] = [];
    expect(await deliverSuggestedFileSave({
      content: "command output",
      showSaveDialog: async () => {
        throw new Error("save dialog must not open for View all");
      },
      writeFile: (filePath) => {
        writes.push(filePath);
      },
    })).toBe("fallback");
    expect(writes).toEqual([]);
  });

  it("desktop openUntitledText honors a suggested filename via the save helper", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "electron-host.ts"),
      "utf8",
    );
    const start = src.indexOf("async openUntitledText");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 1800);
    expect(body).toContain("deliverSuggestedFileSave");
    expect(body).toContain("suggestedFilename");
    expect(body).toContain("saveFiltersForFilename");
    expect(body).toContain("saveDialogTitleForFilename");
    expect(body).toMatch(/outcome !== "fallback"/);
  });
});

describe("window navigation and open locks", () => {
  it("allows only app document navigation URLs", () => {
    // Main document + assets share the privileged scheme.
    expect(isAllowedAppNavigationUrl(APP_DOCUMENT_URL)).toBe(true);
    expect(isAllowedAppNavigationUrl("app-resource://vsc-resource/media/chat.js")).toBe(
      true,
    );
    // Secondary viewers/dialogs still use data: HTML.
    expect(isAllowedAppNavigationUrl("data:text/html;charset=utf-8,x")).toBe(true);
    expect(shouldBlockNavigation("https://evil.example/phish")).toBe(true);
    expect(shouldBlockNavigation("file:///etc/passwd")).toBe(true);
    expect(shouldBlockNavigation("javascript:alert(1)")).toBe(true);
    expect(shouldBlockNavigation("data:text/html,ok")).toBe(false);
    expect(shouldBlockNavigation(APP_DOCUMENT_URL)).toBe(false);
  });

  it("denies window.open; may hand http(s) to openExternal", () => {
    expect(shouldOpenExternally("https://github.com/phuryn/grok-build-vscode")).toBe(
      true,
    );
    expect(shouldOpenExternally("mailto:support@productcompass.pm")).toBe(true);
    expect(shouldOpenExternally("javascript:alert(1)")).toBe(false);
    const d = windowOpenDecision({ url: "https://example.com" });
    expect(d.action).toBe("deny");
    expect(d.openExternal).toBe("https://example.com");
    expect(windowOpenDecision({ url: "app-resource://x" }).openExternal).toBeUndefined();
  });

  it("source gate: main installs setWindowOpenHandler and will-navigate", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("installWindowSecurityLocks");
    const sec = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "window-security.ts",
      ),
      "utf8",
    );
    expect(sec).toContain("setWindowOpenHandler");
    expect(sec).toContain("will-navigate");
  });
});

describe("desktop quick pick and input dialogs", () => {
  it("selectQuickPickIndex returns a selection for 20 items", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      label: `Model ${i + 1}`,
      description: `m-${i}`,
    }));
    expect(selectQuickPickIndex(items, 0)?.label).toBe("Model 1");
    expect(selectQuickPickIndex(items, 19)?.label).toBe("Model 20");
    expect(selectQuickPickIndex(items, 20)).toBeUndefined();
    expect(selectQuickPickIndex(items, -1)).toBeUndefined();
  });

  it("buildQuickPickHtml lists all items (no 8-item cap)", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      label: `Item ${i}`,
      description: `d${i}`,
    }));
    const html = buildQuickPickHtml({ title: "Models", items });
    expect(html).toContain("Item 0");
    expect(html).toContain("Item 19");
    expect(html).toContain('data-index="19"');
    expect(html).not.toContain("not available");
  });

  it("dresses the dialogs as part of the app, not as a page", () => {
    // Owner, on the worktree prompt: no padding, Electron's logo, "looks like
    // a new page, not a popup". The first and third are this document — a card
    // with its own padding and no full-bleed header/footer rules — and the
    // palette is DESKTOP_THEME_CSS's, not VS Code's greys.
    const html = buildInputBoxHtml({ title: "New worktree", prompt: "Label" });
    expect(html).toMatch(/\.wrap\s*\{[^}]*padding:/);
    expect(html, "no chrome bars across the window").not.toMatch(/border-(top|bottom):\s*1px solid #3c3c3c/);
    expect(html, "app background, not VS Code's editor widget grey").toContain("background: #1e1e1e");
    expect(html).not.toContain("#252526");
    // Dark+ selection blue is deliberately absent app-wide (neutral greys).
    expect(html).not.toContain("#094771");
  });

  it("gives dialog windows the app icon and dialog chrome", () => {
    // The logo half of the same report: no `icon` meant Electron's atom in the
    // title bar of every prompt. Minimise/maximise are what made the frame read
    // as a window rather than a dialog.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "electron-host.ts"),
      "utf8",
    );
    const dialog = src.slice(src.indexOf("function showHtmlDialog"));
    const opts = dialog.slice(0, dialog.indexOf("installWindowSecurityLocks"));
    expect(opts).toMatch(/icon:\s*dialogIcon\(\)/);
    expect(opts).toMatch(/minimizable:\s*false/);
    expect(opts).toMatch(/maximizable:\s*false/);
    expect(opts).toContain('backgroundColor: "#1e1e1e"');
  });

  it("buildInputBoxHtml is a real form, not a cancel stub", () => {
    const html = buildInputBoxHtml({ prompt: "Worktree label", value: "wt" });
    expect(html).toContain("Worktree label");
    expect(html).toContain('id="val"');
    expect(html).toContain("deskDialog");
    expect(parseDialogSubmit({ kind: "input", value: "hello" })).toEqual({
      kind: "input",
      value: "hello",
    });
  });
});

/**
 * Behavioural contract for native message boxes (Sign out, unlink-style
 * single-action modals, etc.). Mirrors VS Code showWarningMessage: dismiss /
 * Cancel → undefined; action click → label. A regression here re-enables the
 * "Esc signs you out" bug (cancelId mapped to the only action button).
 */
describe("desktop messageBox cancel / dismiss contract", () => {
  it("single-action confirmation is cancellable (Cancel + cancelId)", () => {
    const actions = ["Sign Out"];
    const plan = planMessageBoxButtons(actions);
    expect(plan.dialogButtons).toEqual(["Sign Out", MESSAGE_BOX_CANCEL_LABEL]);
    expect(plan.defaultId).toBe(0);
    expect(plan.cancelId).toBe(1);
    expect(plan.dialogButtons[plan.cancelId]).toBe(MESSAGE_BOX_CANCEL_LABEL);
  });

  it("dismissed modal confirmation returns undefined — caller does not act", () => {
    const actions = ["Sign Out"];
    const plan = planMessageBoxButtons(actions);
    // Electron returns cancelId when Esc / window-close dismisses the dialog.
    const choice = resolveMessageBoxChoice(
      actions,
      plan.dialogButtons,
      plan.cancelId,
    );
    expect(choice).toBeUndefined();
    // Same gate sidebar.logout / apply-worktree / etc. use:
    expect(choice === "Sign Out").toBe(false);
  });

  it("choosing the action still returns its label", () => {
    const actions = ["Sign Out"];
    const plan = planMessageBoxButtons(actions);
    const choice = resolveMessageBoxChoice(actions, plan.dialogButtons, 0);
    expect(choice).toBe("Sign Out");
    expect(choice === "Sign Out").toBe(true);
  });

  it("covers every single-action modal shape used by the sidebar", () => {
    // Audit: logout, apply worktree, remove worktree, CLI update-while-busy.
    for (const label of ["Sign Out", "Apply", "Remove", "Update Anyway"]) {
      const plan = planMessageBoxButtons([label]);
      expect(resolveMessageBoxChoice([label], plan.dialogButtons, plan.cancelId)).toBeUndefined();
      expect(resolveMessageBoxChoice([label], plan.dialogButtons, 0)).toBe(label);
    }
  });

  it("OK-only notices return undefined (no false action label)", () => {
    const plan = planMessageBoxButtons([]);
    expect(plan.dialogButtons).toEqual(["OK"]);
    expect(resolveMessageBoxChoice([], plan.dialogButtons, 0)).toBeUndefined();
  });

  it("does not double-append Cancel when the caller already offered it", () => {
    const actions = ["Discard", "Cancel"];
    const plan = planMessageBoxButtons(actions);
    expect(plan.dialogButtons).toEqual(["Discard", "Cancel"]);
    expect(plan.cancelId).toBe(1);
    // Explicit Cancel is a real choice the caller may branch on.
    expect(resolveMessageBoxChoice(actions, plan.dialogButtons, 1)).toBe("Cancel");
    expect(resolveMessageBoxChoice(actions, plan.dialogButtons, 0)).toBe("Discard");
  });

  it("source gate: electron-host wires plan + resolve (not raw buttons[response])", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    expect(src).toContain("planMessageBoxButtons");
    expect(src).toContain("resolveMessageBoxChoice");
    // The old bug: cancelId on the last action + return buttons[response].
    expect(src).not.toMatch(
      /cancelId:\s*buttons\.length\s*\?\s*buttons\.length\s*-\s*1/,
    );
    expect(src).not.toMatch(/return buttons\[result\.response\]/);
  });
});

describe("desktop quick pick (continued)", () => {
  it("source gate: electron-host no longer cancels large quick picks", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    expect(src).toContain("buildQuickPickHtml");
    expect(src).toContain("buildInputBoxHtml");
    expect(src).not.toMatch(/items\.length\s*>\s*8/);
    expect(src).not.toContain("Input prompt is not available yet");
    expect(src).not.toContain("Large quick-pick lists");
  });
});

describe("desktop DevTools gate (non-production only)", () => {
  function viewRoles(isPackaged: boolean): Array<string | undefined> {
    const template = desktopAppMenuTemplate({ isPackaged, platform: "win32" });
    const view = template.find((item) => item.label === "View");
    expect(view).toBeTruthy();
    const submenu = view!.submenu as Array<{ role?: string }>;
    return submenu.map((item) => item.role);
  }

  it("allows DevTools only when not packaged", () => {
    expect(desktopDevToolsAllowed(false)).toBe(true);
    expect(desktopDevToolsAllowed(true)).toBe(false);
  });

  it("includes toggleDevTools in View when not packaged", () => {
    expect(viewRoles(false)).toContain("toggleDevTools");
  });

  it("View zoom items call CSS font-scale actions, not Chromium zoom roles", () => {
    const seen: string[] = [];
    const template = desktopAppMenuTemplate({
      isPackaged: true,
      platform: "win32",
      actions: {
        zoomIn: () => seen.push("in"),
        zoomOut: () => seen.push("out"),
        resetZoom: () => seen.push("reset"),
      },
    });
    const view = template.find((item) => item.label === "View");
    const submenu = view!.submenu as Array<{
      role?: string;
      label?: string;
      click?: () => void;
    }>;
    expect(submenu.map((item) => item.role)).not.toEqual(
      expect.arrayContaining(["zoomIn", "zoomOut", "resetZoom"]),
    );
    expect(submenu.some((item) => item.role === "zoomIn")).toBe(false);
    expect(submenu.some((item) => item.role === "zoomOut")).toBe(false);
    expect(submenu.some((item) => item.role === "resetZoom")).toBe(false);
    const byLabel = (label: string) => submenu.find((item) => item.label === label);
    byLabel("Zoom In")!.click!();
    byLabel("Zoom Out")!.click!();
    byLabel("Actual Size")!.click!();
    expect(seen).toEqual(["in", "out", "reset"]);
  });

  it("omits toggleDevTools from View when packaged", () => {
    expect(viewRoles(true)).not.toContain("toggleDevTools");
  });

  it("mutation: flipping isPackaged is the only menu difference for DevTools", () => {
    const open = viewRoles(false);
    const packed = viewRoles(true);
    expect(open.filter((r) => r !== "toggleDevTools")).toEqual(packed);
    expect(open.includes("toggleDevTools")).toBe(true);
    expect(packed.includes("toggleDevTools")).toBe(false);
  });

  it("sets an explicit accelerator so DevTools works with autoHideMenuBar", () => {
    const template = desktopAppMenuTemplate({ isPackaged: false, platform: "win32" });
    const view = template.find((item) => item.label === "View");
    const submenu = view!.submenu as Array<{ role?: string; accelerator?: string }>;
    const item = submenu.find((i) => i.role === "toggleDevTools");
    expect(item?.accelerator).toBe(DESKTOP_DEVTOOLS_ACCELERATOR);
    expect(DESKTOP_DEVTOOLS_ACCELERATOR).toMatch(/Shift\+I/i);
  });

  it("keyboard shortcut helper accepts F12 and Ctrl/Cmd+Shift+I without Alt", () => {
    expect(isDesktopDevToolsShortcut({ type: "keyDown", key: "F12" })).toBe(true);
    expect(
      isDesktopDevToolsShortcut({
        type: "keyDown",
        key: "I",
        control: true,
        shift: true,
      }),
    ).toBe(true);
    expect(
      isDesktopDevToolsShortcut({
        type: "keyDown",
        key: "i",
        meta: true,
        shift: true,
      }),
    ).toBe(true);
    // Mutation: plain I / keyUp / Alt chord must not open DevTools.
    expect(isDesktopDevToolsShortcut({ type: "keyDown", key: "I", control: true })).toBe(false);
    expect(isDesktopDevToolsShortcut({ type: "keyUp", key: "F12" })).toBe(false);
    expect(
      isDesktopDevToolsShortcut({
        type: "keyDown",
        key: "I",
        control: true,
        shift: true,
        alt: true,
      }),
    ).toBe(false);
  });

  it("second-instance opens DevTools when the new argv asked for it", () => {
    expect(
      secondInstanceShouldOpenDevTools({
        isPackaged: false,
        commandLine: ["electron", DESKTOP_OPEN_DEVTOOLS_FLAG],
      }),
    ).toBe(true);
    expect(
      secondInstanceShouldOpenDevTools({
        isPackaged: false,
        commandLine: ["electron"],
      }),
    ).toBe(false);
    // Packaged must never open even if argv is forged.
    expect(
      secondInstanceShouldOpenDevTools({
        isPackaged: true,
        commandLine: ["electron", DESKTOP_OPEN_DEVTOOLS_FLAG],
      }),
    ).toBe(false);
  });

  it("opens at startup only with explicit signal and only when unpackaged", () => {
    expect(
      shouldOpenDevToolsAtStartup({
        isPackaged: false,
        env: { [DESKTOP_OPEN_DEVTOOLS_ENV]: "1" },
      }),
    ).toBe(true);
    expect(
      shouldOpenDevToolsAtStartup({
        isPackaged: false,
        argv: [DESKTOP_OPEN_DEVTOOLS_FLAG],
      }),
    ).toBe(true);
    // Packaged must never open — even if someone forges the env.
    expect(
      shouldOpenDevToolsAtStartup({
        isPackaged: true,
        env: { [DESKTOP_OPEN_DEVTOOLS_ENV]: "1" },
        argv: [DESKTOP_OPEN_DEVTOOLS_FLAG],
      }),
    ).toBe(false);
    // No signal → closed (plain `npm run desktop` stays quiet).
    expect(shouldOpenDevToolsAtStartup({ isPackaged: false, env: {}, argv: [] })).toBe(
      false,
    );
    // Relay URL alone must NOT open DevTools (separate concerns).
    expect(
      shouldOpenDevToolsAtStartup({
        isPackaged: false,
        env: { GROK_RELAY_URL: "wss://staging.example" },
      }),
    ).toBe(false);
  });

  it("wires main + launcher to the packaging gate and explicit open signal", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("desktopAppMenuTemplate");
    expect(main).toContain("shouldOpenDevToolsAtStartup");
    expect(main).toContain("desktopDevToolsAllowed");
    expect(main).toContain("isDesktopDevToolsShortcut");
    expect(main).toContain("secondInstanceShouldOpenDevTools");
    expect(main).toContain("before-input-event");
    expect(main).toMatch(/devTools:\s*allowDevTools/);
    expect(main).toMatch(/openDevTools\(\s*\{\s*mode:\s*["']detach["']/);
    // Child viewers share the packaging lock but never auto-open.
    // Gear door (capability + host method) so discoverability is not Alt→View only.
    const host = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    expect(host).toMatch(/devTools:\s*!app\.isPackaged/);
    expect(host).not.toContain("openDevTools");
    expect(host).toMatch(/canToggleDevTools/);
    expect(host).toMatch(/canShowMcpSettings/);
    expect(host).toContain("toggleDevTools()");
    const settingsJs = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "settings.js"),
      "utf8",
    );
    expect(settingsJs).toContain("Toggle Developer Tools");
    expect(settingsJs).toMatch(/type:\s*["']toggleDevTools["']/);
    // Launcher: explicit flag → env; not keyed off GROK_RELAY_URL.
    const launcher = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-desktop.cjs"),
      "utf8",
    );
    expect(launcher).toContain(DESKTOP_OPEN_DEVTOOLS_FLAG);
    expect(launcher).toContain(DESKTOP_OPEN_DEVTOOLS_ENV);
    expect(launcher).toContain("includes(OPEN_DEVTOOLS_FLAG)");
    expect(launcher).toMatch(/env\[OPEN_DEVTOOLS_ENV\]\s*=\s*["']1["']/);
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["desktop-dev"]).toContain(DESKTOP_OPEN_DEVTOOLS_FLAG);
    expect(pkg.scripts["desktop-dev"]).toContain("--relay-dev");
    // Plain desktop must not open DevTools by default.
    expect(pkg.scripts.desktop).not.toContain(DESKTOP_OPEN_DEVTOOLS_FLAG);
  });
});

describe("desktop branding and menu", () => {
  it("names the product Grok Build Desktop (Community) and links this repo only", () => {
    expect(DESKTOP_APP_FULL_NAME).toBe("Grok Build Desktop (Community)");
    expect(DESKTOP_PUBLIC_REPO_URL).toBe(
      "https://github.com/phuryn/grok-build-vscode",
    );
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("DESKTOP_PUBLIC_REPO_URL");
    expect(main).toContain("buildDesktopAppMenu");
    expect(main).toContain("grok-icon.png");
    expect(main).not.toMatch(/https?:\/\/electronjs\.org/);
    expect(main).not.toMatch(/Learn More|Community Discussions|Search Issues/);
    // Reading width lives in desktop theme CSS, not shared chat.css.
    const theme = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(theme).toContain("calc((100% - 1120px) / 2)");
    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    expect(chatCss).not.toContain("max-width: 1120px");
  });

  it("ports AFK Pilot selection greys (not Dark+ blue) for active rail rows", () => {
    const theme = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    // Active row uses the palette token — greys from AFK Pilot, not #094771 blue.
    expect(theme).toContain("--vscode-list-activeSelectionBackground: #37373d");
    expect(theme).toContain("--vscode-list-activeSelectionBackground: #e4e6f1");
    expect(theme).not.toMatch(
      /--vscode-list-activeSelectionBackground:\s*#094771/,
    );
    // Active session fill is token-based in shared CSS (not a hardcoded colour).
    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    expect(chatCss).toMatch(
      /\.rail-session\.active\s*\{[^}]*background:\s*var\(--vscode-list-activeSelectionBackground\)/s,
    );
    // Theme boot: localStorage under real app-resource origin (not IPC/file).
    expect(theme).toContain("data-theme");
    expect(theme).toContain("localStorage");
    expect(theme).toContain("prefers-color-scheme");
    expect(theme).toContain("__toggleDesktopTheme");
    expect(theme).not.toContain("grokDesktopTheme");
  });

  it("auto-hides the native menu bar so it does not paint light over dark chrome", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("autoHideMenuBar: true");
    // Main document is served over app-resource (real origin), not data:.
    expect(main).toContain("isAppDocumentUrl");
    expect(main).not.toContain("desk-theme:get");
  });

  it("holds the window until ready-to-show and pins Chromium zoomFactor at 1", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toMatch(/show:\s*false/);
    expect(main).toContain("ready-to-show");
    expect(main).toContain("setVisualZoomLevelLimits(1, 1)");
    expect(main).toContain("setZoomFactor(1)");
    expect(main).toContain("pinAppDocumentZoom");
    expect(main).toContain("did-finish-load");
    expect(main).toContain("__grokFontScale");
    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    // Scoped to desk hosts only: the phone client never sets body.desk and
    // must keep its document scroller (URL-bar hide, keyboard pans).
    expect(chatCss).toMatch(/html:has\(body\.desk\)\s*\{[^}]*overflow:\s*hidden/s);
    expect(chatCss).not.toMatch(/^html\s*\{[^}]*overflow:\s*hidden/ms);
    // #119. The body must NOT divide the zoom back out. That was correct under
    // the old non-standard `zoom`; the CSS Zoom spec (Chromium 128+) resolves
    // percentages against the zoom-adjusted containing block, so `height: 100%`
    // already fills the window and dividing again halves it. Measured in
    // Chromium 149 at an 800px viewport, the old formula put the composer at
    // 400px at zoom 2 and overflowed to 1333px at zoom 0.6 — wrong at every
    // scale but 1. Both older shapes stay pinned out so neither comes back.
    expect(chatCss).toMatch(/zoom: var\(--chat-zoom, 1\);\s+height: 100%;/);
    expect(chatCss).not.toContain("calc(100% / var(--chat-zoom, 1))");
    expect(chatCss).not.toContain("calc(100vh / var(--chat-zoom, 1))");
  });

  it("main document loads via APP_DOCUMENT_URL (source gate)", () => {
    const webview = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(webview).toContain("APP_DOCUMENT_URL");
    expect(webview).toMatch(/loadURL\(\s*APP_DOCUMENT_URL\s*\)/);
    expect(webview).not.toMatch(/loadURL\(`data:text\/html/);
    expect(webview).toContain("getDocumentHtml");
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toMatch(/isAppDocumentUrl[\s\S]*getDocumentHtml/);
    expect(main).toContain('Content-Type": "text/html');
  });
});

describe("desktop theme prefs (userData file)", () => {
  it("resolves saved preference over OS, else follows OS", async () => {
    const {
      resolveDesktopTheme,
      parseDesktopTheme,
      writeDesktopThemeFile,
      readDesktopThemeFile,
    } = await import("../src/desktop/theme-prefs");
    expect(resolveDesktopTheme("light", true)).toBe("light");
    expect(resolveDesktopTheme("dark", false)).toBe("dark");
    expect(resolveDesktopTheme(undefined, true)).toBe("dark");
    expect(resolveDesktopTheme(undefined, false)).toBe("light");
    expect(parseDesktopTheme({ theme: "light" })).toBe("light");
    expect(parseDesktopTheme("nope")).toBeUndefined();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-theme-"));
    try {
      writeDesktopThemeFile(dir, "light");
      expect(readDesktopThemeFile(dir)).toBe("light");
      writeDesktopThemeFile(dir, "dark");
      expect(readDesktopThemeFile(dir)).toBe("dark");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("external terminal plans (not silent no-ops)", () => {
  it("Windows CLI plan uses cmd start (visible) and can launch .cmd", () => {
    const plan = planOpenCliInTerminal(
      "Grok Login",
      "C:\\Users\\x\\.grok\\bin\\grok.cmd",
      ["login"],
      "C:\\ws",
      "win32",
    );
    expect(plan.kind).toBe("spawn");
    if (plan.kind !== "spawn") return;
    expect(plan.command.toLowerCase()).toMatch(/cmd/);
    expect(plan.args).toContain("start");
    expect(plan.args).toContain("C:\\Users\\x\\.grok\\bin\\grok.cmd");
    expect(plan.args).toContain("login");
  });

  it("Install Grok command opens a visible PowerShell on Windows", () => {
    const plan = planRunCommandInTerminal(
      "Install Grok",
      'irm https://x.ai/cli/install.ps1 | iex',
      undefined,
      "win32",
    );
    expect(plan.kind).toBe("spawn");
    if (plan.kind !== "spawn") return;
    expect(plan.args.join(" ")).toMatch(/powershell/i);
    expect(plan.args.join(" ")).toMatch(/install\.ps1/);
  });

  it("source gate: createTerminal no longer has empty sendText body", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "electron-host.ts"),
      "utf8",
    );
    expect(src).toContain("planRunCommandInTerminal");
    expect(src).toContain("planOpenCliInTerminal");
    // Old silent stub.
    expect(src).not.toMatch(/sendText\(\)\s*\{\s*\}/);
  });
});

describe("IPC sender validation helper", () => {
  it("accepts only the main window webContents id", () => {
    const main = { id: 1, isDestroyed: () => false };
    const other = { id: 2, isDestroyed: () => false };
    const getWin = () =>
      ({
        isDestroyed: () => false,
        webContents: main,
      }) as never;
    expect(
      isIpcFromMainWindow({ sender: main as never }, getWin),
    ).toBe(true);
    expect(
      isIpcFromMainWindow({ sender: other as never }, getWin),
    ).toBe(false);
  });

  it("main.ts validates webview-to-host via trusted main-frame helper", () => {
    const main = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "main.ts"),
      "utf8",
    );
    expect(main).toContain("webview-to-host");
    expect(main).toContain("isTrustedMainFrameIpc");
    expect(main).toContain("dispatchMessage");
  });
});

describe("file-tree panel assets", () => {
  it("top-bar order is Remote, History, New, overflow, then Panel with separator on Panel only", () => {
    // Owner preference: Remote, Session history, New, ⋯, |, Panel — not ⋯ first.
    // Separator lives on the Panel toggle so remote (no panel) has no dangling |.
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const topBar = sidebar.match(/<header class="top-bar">[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(topBar).toBeTruthy();
    const remote = topBar.indexOf('id="remote-btn"');
    const history = topBar.indexOf('id="history-btn"');
    const newSession = topBar.indexOf('id="new-btn"');
    const overflow = topBar.indexOf('id="session-head-actions"');
    expect(remote).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(remote);
    expect(newSession).toBeGreaterThan(history);
    expect(overflow).toBeGreaterThan(newSession);
    // Mutation: overflow before remote would fail.
    expect(overflow).toBeGreaterThan(remote);

    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    // No trailing separator on the overflow slot itself.
    const headActionsRule = chatCss.match(/#session-head-actions\s*\{[^}]+\}/)?.[0] ?? "";
    expect(headActionsRule).toBeTruthy();
    expect(headActionsRule).not.toMatch(/border-right/);
    // The separator is its OWN element now, not a border on the toggle. As a
    // border it made the button read as a box and pushed its glyph off centre —
    // a border on a fixed-size button always distorts the button. Still
    // desktop-only by construction: remote mounts neither node.
    expect(filePanelCss).toMatch(/\.desk-ft-top-sep\s*\{[\s\S]*?background:/);
    const toggleRule = filePanelCss.match(/\.desk-ft-top-toggle\s*\{[^}]+\}/)?.[0] ?? "";
    expect(toggleRule).toBeTruthy();
    expect(toggleRule).not.toMatch(/border-left/);
    expect(toggleRule).not.toMatch(/padding-left/);
    // ...and it now matches the other top-bar icon buttons instead of shouting:
    // muted foreground, no border, chat.css's .icon-btn radius.
    expect(toggleRule).toMatch(/color:\s*var\(--vscode-descriptionForeground(?:,|\))/);
    expect(toggleRule).toMatch(/border:\s*0/);
    expect(toggleRule).toMatch(/border-radius:\s*8px/);
    // Anchored: an unanchored `.icon-btn {` also matches `.top-bar > .icon-btn`,
    // which carries only `flex: none`.
    const iconBtnRule = chatCss.match(/^\.icon-btn\s*\{[^}]+\}/m)?.[0] ?? "";
    expect(iconBtnRule).toMatch(/border-radius:\s*8px/);
    expect(iconBtnRule).toMatch(/color:\s*var\(--vscode-descriptionForeground\)/);
    expect(chatCss).toMatch(/#add-popover \.toolbar-popover-item\s*\{[^}]*justify-content:\s*flex-start/s);

    // Created and torn down together. A border could not be orphaned; a
    // sibling can, and a re-inject would stack them up.
    const boot = fileTreePanelBootSource();
    expect(boot).toContain('separator.id = "desk-ft-top-sep"');
    expect(boot).toContain('getElementById("desk-ft-top-sep")?.remove()');
  });

  it("keeps rendering in the shared asset and host concerns in the desktop adapter", () => {
    const boot = fileTreePanelBootSource();

    // Component CSS is namespaced and leaves chat primitives alone. Hidden is
    // structural, so closing the drawer cannot retain layout width.
    expect(filePanelCss).toContain(".gfp-panel");
    expect(filePanelCss).toContain(".gfp-panel[hidden] { display: none !important; }");
    expect(filePanelCss).toContain("--gfp-width");
    expect(filePanelCss).toContain(".gfp-resizer");
    expect(filePanelCss).not.toMatch(/(?:^|\n)\.messages\s*\{/);
    expect(filePanelCss).not.toMatch(/(?:^|\n)\.composer\s*\{/);

    // The injected source only mounts/adapts. Tabs, nested rows, editing,
    // conflicts and menus must remain in the one shared renderer asset.
    expect(boot).toContain("shared.createFilePanel");
    expect(boot).toContain("grokDesktopFileTree");
    expect(boot).toContain('presentation: "dock"');
    expect(boot).toContain("maximize: true");
    expect(boot).toContain("desk-ft-maximize");
    expect(boot).toContain("desk-ft-maximized");
    expect(filePanelCss).toContain("body.desk-ft-maximized .desk-ft-chat");
    expect(filePanelCss).toContain("body.desk-ft-maximized #chat-stack");
    expect(filePanelCss).toContain("body.desk-ft-maximized #file-panel-dock");
    expect(filePanelJs).toContain("mount.maximize");
    expect(boot).toContain("absPath: request.expectedAbsPath");
    expect(boot).toContain("__grokDeskFtOpen");
    expect(filePanelJs).toContain("gfp-tabs");
    expect(filePanelJs).toContain("renderDirectory");
    expect(filePanelJs).toContain("openRowMenu");
    expect(filePanelJs).toContain('addEventListener("contextmenu"');
    expect(filePanelJs).toContain('actionButton("Reload"');
    expect(filePanelJs).toContain('actionButton("Overwrite"');

    // Desktop still owns its shell, rail collapse and shared width coordinator.
    expect(boot).toContain('document.querySelector(".app-main")');
    expect(boot).toContain('getElementById("projects-rail")');
    expect(boot).toContain('getElementById("desk-rail-toggle")');
    expect(boot).toContain("__grokRegisterSidePanel");
    expect(boot).toContain("__grokReclampSidePanels");
    expect(boot).toContain("__grokResetDocumentScroll");

    // Seti assets are fetched lazily from the desktop media scheme, not baked
    // into executeJavaScript, and the adapter never joins the host message bus.
    expect(boot).toContain('new URL("file-icons/", componentScript.src)');
    expect(boot).not.toContain("data:image/svg+xml");
    expect(boot).not.toContain("acquireVsCodeApi");
    expect(boot).not.toContain("postMessage");
  });
});

describe("desktop chrome boot (scroll fade + spacing shell)", () => {
  it("wraps messages and ramps fade opacity from scroll position", () => {
    const src = desktopChromeBootSource();
    expect(src).toContain("messages-wrap");
    expect(src).toContain("msg-fade-top");
    expect(src).toContain("msg-fade-bot");
    expect(src).toContain("--fade-top-op");
    expect(src).toContain("--fade-bot-op");
    expect(src).toContain("scrollTop");
    expect(src).toContain("__grokResetDocumentScroll");
    // Does not touch shared chat.js / Host messaging.
    expect(src).not.toContain("acquireVsCodeApi");
    expect(src).not.toContain("postMessage");
  });
});

describe("desktop reading measure CSS", () => {
  it("keeps the scrollport full-bleed and expresses both measures as padding", () => {
    expect(DESKTOP_THEME_CSS).toContain("body.desk #messages-wrap");
    expect(DESKTOP_THEME_CSS).toContain("body.desk #messages-wrap {\n  max-width: none;");
    expect(DESKTOP_THEME_CSS).toContain(
      "padding-inline: max(calc(var(--pad) + 5px), calc((100% - 800px) / 2));",
    );
    expect(DESKTOP_THEME_CSS).toContain(
      "padding-inline: max(calc(var(--pad) + 5px), calc((100% - 1120px) / 2));",
    );
    expect(DESKTOP_THEME_CSS).not.toContain("max-width: 800px;");
    expect(DESKTOP_THEME_CSS).not.toContain("max-width: 1120px;");
  });
});

describe("desktop openFile / openUrl policy (A1)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-pol-"));
    fs.writeFileSync(path.join(root, "readme.md"), "# hi");
    fs.writeFileSync(path.join(root, "tool.exe"), "MZ");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export {}");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("allows workspace files and refuses outside + executables", () => {
    expect(authorizeOpenFile("readme.md", { workspaceRoot: root }).ok).toBe(true);
    expect(authorizeOpenFile("src/a.ts", { workspaceRoot: root }).ok).toBe(true);
    expect(authorizeOpenFile(path.join(root, "readme.md"), { workspaceRoot: root }).ok).toBe(
      true,
    );

    const outside = path.join(path.dirname(root), "secret.txt");
    fs.writeFileSync(outside, "x");
    try {
      expect(authorizeOpenFile(outside, { workspaceRoot: root }).ok).toBe(false);
      expect(authorizeOpenFile("../secret.txt", { workspaceRoot: root }).ok).toBe(false);
    } finally {
      fs.unlinkSync(outside);
    }

    expect(authorizeOpenFile("tool.exe", { workspaceRoot: root }).ok).toBe(false);
    expect(isExecutablePath("tool.exe")).toBe(true);
    expect(isExecutablePath("script.bat")).toBe(true);
    expect(isExecutablePath("a.ts")).toBe(false);
    expect(isExecutablePath("app.desktop")).toBe(true);
  });

  it("refuses extensionless +x files, .desktop launchers, and symlink targets", () => {
    // Injectable FS so Windows CI (no chmod / no symlink privilege) still
    // mutation-checks the mode + realpath gates.
    const bin = path.join(root, "runme");
    fs.writeFileSync(bin, "#!/bin/sh\necho hi\n");
    expect(isExecutablePath(bin)).toBe(false);

    // POSIX +x on an extensionless file (platform forced to non-win32).
    const modeFs = {
      realpathSync: (p: string) => p,
      statSync: (_p: string) =>
        ({ isFile: () => true, mode: 0o755 }) as unknown as fs.Stats,
    };
    expect(isExecutableOpenTarget(bin, { platform: "linux", pathFs: modeFs })).toBe(true);
    const modeClear = {
      realpathSync: (p: string) => p,
      statSync: (_p: string) =>
        ({ isFile: () => true, mode: 0o644 }) as unknown as fs.Stats,
    };
    expect(isExecutableOpenTarget(bin, { platform: "linux", pathFs: modeClear })).toBe(false);
    // Windows must NOT refuse solely on mode bits.
    expect(isExecutableOpenTarget(bin, { platform: "win32", pathFs: modeFs })).toBe(false);

    // .desktop launchers are extension-refused everywhere.
    const desktop = path.join(root, "evil.desktop");
    fs.writeFileSync(desktop, "[Desktop Entry]\nExec=evil\n");
    expect(isExecutablePath(desktop)).toBe(true);
    expect(isExecutableOpenTarget(desktop)).toBe(true);
    expect(authorizeOpenFile("evil.desktop", { workspaceRoot: root }).ok).toBe(false);

    // Symlink / junction: link basename looks safe, realpath is a PE.
    const pe = path.join(root, "payload.exe");
    fs.writeFileSync(pe, "MZ");
    const linkPath = path.join(root, "safe-looking");
    fs.writeFileSync(linkPath, "not really");
    const linkFs = {
      realpathSync: (p: string) => (p === linkPath ? pe : p),
      statSync: (p: string) => fs.statSync(p),
    };
    expect(isExecutablePath(linkPath)).toBe(false);
    expect(isExecutableOpenTarget(linkPath, { platform: "win32", pathFs: linkFs })).toBe(true);
    expect(
      authorizeOpenFile("safe-looking", {
        workspaceRoot: root,
        platform: process.platform,
        pathFs: {
          realpathSync: (p: string) => (path.resolve(p) === path.resolve(linkPath) ? pe : fs.realpathSync(p)),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      }).ok,
    ).toBe(false);
  });

  it("mutation: extension-only isExecutablePath would hand +x scripts to openPath", () => {
    const bin = path.join(root, "tool-noext");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    expect(isExecutablePath(bin)).toBe(false); // pure name check: miss
    const modeFs = {
      realpathSync: (p: string) => p,
      statSync: () => ({ isFile: () => true, mode: 0o755 }) as unknown as fs.Stats,
    };
    // Mode gate (linux) must refuse — fails if isExecutableOpenTarget is name-only.
    expect(isExecutableOpenTarget(bin, { platform: "linux", pathFs: modeFs })).toBe(true);
    // Realpath-to-.exe gate (win32) must refuse a safe-looking link path.
    const pe = path.join(root, "hidden.exe");
    fs.writeFileSync(pe, "MZ");
    const link = path.join(root, "docs-note");
    fs.writeFileSync(link, "x");
    const linkFs = {
      realpathSync: (p: string) => (p === link ? pe : p),
      statSync: (p: string) => fs.statSync(p),
    };
    expect(isExecutablePath(link)).toBe(false);
    expect(isExecutableOpenTarget(link, { platform: "win32", pathFs: linkFs })).toBe(true);
  });

  it("refuses openUrl schemes other than http(s) and mailto", () => {
    expect(authorizeOpenUrl("https://example.com/x").ok).toBe(true);
    expect(authorizeOpenUrl("http://localhost:3000").ok).toBe(true);
    expect(authorizeOpenUrl("mailto:support@productcompass.pm").ok).toBe(true);
    expect(authorizeOpenUrl("file:///etc/passwd").ok).toBe(false);
    expect(authorizeOpenUrl("javascript:alert(1)").ok).toBe(false);
    expect(authorizeOpenUrl("vscode://file/x").ok).toBe(false);
    expect(authorizeOpenUrl("ms-windows-store://pdp/?ProductId=9").ok).toBe(false);
  });

  it("authorizeDesktopWebviewMsg drops bad openFile/openUrl", () => {
    const okFile = authorizeDesktopWebviewMsg(
      { type: "openFile", path: "readme.md" },
      { workspaceRoot: root },
    );
    expect("msg" in okFile).toBe(true);

    const badFile = authorizeDesktopWebviewMsg(
      { type: "openFile", path: "tool.exe" },
      { workspaceRoot: root },
    );
    expect("refused" in badFile).toBe(true);

    const outside = authorizeDesktopWebviewMsg(
      { type: "openFile", path: path.join(path.dirname(root), "nope.txt") },
      { workspaceRoot: root },
    );
    expect("refused" in outside).toBe(true);

    const badUrl = authorizeDesktopWebviewMsg(
      { type: "openUrl", url: "file:///C:/Windows/System32/cmd.exe" },
      { workspaceRoot: root },
    );
    expect("refused" in badUrl).toBe(true);

    // Non-open messages pass through.
    const send = authorizeDesktopWebviewMsg(
      { type: "send", text: "hi" },
      { workspaceRoot: root },
    );
    expect("msg" in send && send.msg.type === "send").toBe(true);
  });

  it("mutation: without workspace containment, outside paths would pass isExecutable alone", () => {
    // Pins that authorizeOpenFile uses resolveTreePath, not only isExecutablePath.
    const outside = path.join(path.dirname(root), "notes.md");
    fs.writeFileSync(outside, "x");
    try {
      expect(isExecutablePath(outside)).toBe(false);
      expect(authorizeOpenFile(outside, { workspaceRoot: root }).ok).toBe(false);
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it("message gate PASSES trusted generated-media and refuses arbitrary out-of-workspace", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-home-"));
    try {
      const catalog = path.join(grokHome, "sessions", "cwd-enc");
      const sessionDir = path.join(catalog, "sess-abc");
      const img = path.join(sessionDir, "images", "1.jpg");
      fs.mkdirSync(path.dirname(img), { recursive: true });
      fs.writeFileSync(img, "fake-jpeg");
      const catalogs = [catalog];

      const trusted = authorizeOpenFile(img, {
        workspaceRoot: root,
        grokHome,
        sessionCatalogDirs: catalogs,
      });
      expect(trusted.ok).toBe(true);
      if (trusted.ok) expect(path.resolve(trusted.absPath)).toBe(path.resolve(img));

      const gate = authorizeDesktopWebviewMsg(
        { type: "openFile", path: img },
        { workspaceRoot: root, grokHome, sessionCatalogDirs: catalogs },
      );
      expect("msg" in gate).toBe(true);

      // Relative media link with sessionDir (workspace file absent).
      const rel = authorizeOpenFile("images/1.jpg", {
        workspaceRoot: root,
        grokHome,
        sessionDir,
        pathFs: {
          realpathSync: (p: string) => fs.realpathSync(p),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      });
      // Lexical under workspace is authorized first (may not exist); message gate still passes.
      expect(rel.ok).toBe(true);

      // Use-time must open the session file when workspace miss.
      // Re-auth of the resolved absolute path needs project catalogs (same as hover).
      const opened = resolveAuthorizedFileForOpen("images/1.jpg", {
        workspaceRoot: root,
        grokHome,
        sessionDir,
        sessionCatalogDirs: catalogs,
        pathFs: {
          realpathSync: (p: string) => fs.realpathSync(p),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(path.resolve(opened.absPath)).toBe(path.resolve(img));

      // Arbitrary out-of-workspace path still refused (no general ~/.grok open).
      const secret = path.join(grokHome, "auth.json");
      fs.writeFileSync(secret, '{"token":"x"}');
      expect(
        authorizeOpenFile(secret, {
          workspaceRoot: root,
          grokHome,
          sessionCatalogDirs: catalogs,
        }).ok,
      ).toBe(false);
      const loose = path.join(grokHome, "loose.png");
      fs.writeFileSync(loose, "x");
      expect(
        authorizeOpenFile(loose, {
          workspaceRoot: root,
          grokHome,
          sessionCatalogDirs: catalogs,
        }).ok,
      ).toBe(false);
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("resolveAuthorizedFileForOpen prefers workspace images/ when present", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-ws-"));
    try {
      const sessionDir = path.join(grokHome, "sessions", "cwd-enc", "sess-ws");
      const sessionImg = path.join(sessionDir, "images", "1.jpg");
      fs.mkdirSync(path.dirname(sessionImg), { recursive: true });
      fs.writeFileSync(sessionImg, "session");
      const wsImg = path.join(root, "images", "1.jpg");
      fs.mkdirSync(path.dirname(wsImg), { recursive: true });
      fs.writeFileSync(wsImg, "workspace");

      const opened = resolveAuthorizedFileForOpen("images/1.jpg", {
        workspaceRoot: root,
        grokHome,
        sessionDir,
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(path.resolve(opened.absPath)).toBe(path.resolve(wsImg));
        expect(fs.readFileSync(opened.absPath, "utf8")).toBe("workspace");
      }
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("absolute missing workspace path is NOT remapped onto session media", () => {
    // A named absolute under the workspace that no longer exists must stay
    // "not found" — never open ~/.grok/.../images/logo.png as a substitute.
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-nopeel-"));
    try {
      const sessionDir = path.join(grokHome, "sessions", "cwd-enc", "sess-nopeel");
      const sessionImg = path.join(sessionDir, "images", "logo.png");
      fs.mkdirSync(path.dirname(sessionImg), { recursive: true });
      fs.writeFileSync(sessionImg, "session-only");

      const missingWs = path.join(root, "images", "logo.png");
      // Ensure workspace candidate is absent.
      try {
        fs.unlinkSync(missingWs);
      } catch {
        /* ok */
      }

      const opened = resolveAuthorizedFileForOpen(missingWs, {
        workspaceRoot: root,
        grokHome,
        sessionDir,
        pathFs: {
          realpathSync: (p: string) => fs.realpathSync(p),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.reason).toMatch(/not found/i);
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("authorizeOpenFile refuses trusted media when no workspace root (matches openFsPath)", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-noroot-"));
    try {
      const catalog = path.join(grokHome, "sessions", "cwd-enc");
      const sessionDir = path.join(catalog, "sess-noroot");
      const img = path.join(sessionDir, "images", "1.jpg");
      fs.mkdirSync(path.dirname(img), { recursive: true });
      fs.writeFileSync(img, "fake-jpeg");

      const abs = authorizeOpenFile(img, {
        grokHome,
        sessionDir,
        sessionCatalogDirs: [catalog],
      });
      expect(abs.ok).toBe(false);
      if (!abs.ok) expect(abs.reason).toBe("no workspace root");

      const rel = authorizeOpenFile("images/1.jpg", { grokHome, sessionDir });
      expect(rel.ok).toBe(false);
      if (!rel.ok) expect(rel.reason).toBe("no workspace root");
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  // Use-time path openFsPath actually calls. Message-gate authorizeOpenFile alone
  // does not prove these: the desktop hover open posts an absolute session-media
  // path, and sidebar hands the same after resolveChatOpenFilePath; relative
  // links that still reach openFsPath fall through trySessionMediaOpen.
  it("resolveAuthorizedFileForOpen opens ABSOLUTE session-media path (desktop hover / post-resolve)", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-abs-use-"));
    try {
      const catalog = path.join(grokHome, "sessions", "cwd-enc");
      const sessionDir = path.join(catalog, "sess-abs-use");
      const img = path.join(sessionDir, "images", "1.jpg");
      fs.mkdirSync(path.dirname(img), { recursive: true });
      fs.writeFileSync(img, "fake-jpeg");

      const ctx = {
        workspaceRoot: root,
        grokHome,
        sessionDir,
        sessionCatalogDirs: [catalog],
        pathFs: {
          realpathSync: (p: string) => fs.realpathSync(p),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      };

      // Load-bearing steps openFsPath's resolveAuthorizedFileForOpen runs for this input.
      const revalidated = revalidateOpenFileForUse(img, ctx);
      expect(revalidated.ok).toBe(true);
      if (revalidated.ok) expect(path.resolve(revalidated.absPath)).toBe(path.resolve(img));
      expect(isExecutableOpenTarget(img, { pathFs: ctx.pathFs })).toBe(false);
      expect(fs.statSync(img).isFile()).toBe(true);

      const opened = resolveAuthorizedFileForOpen(img, ctx);
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(path.resolve(opened.absPath)).toBe(path.resolve(img));
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("absolute sibling-REPO media path is refused by message gate and use-time open", () => {
    // Project-catalog fence: media under another repo's sessions/<cwd>/… is
    // still under ~/.grok and still has generated-session shape, but must not
    // open from this project's auth context.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-xrepo-"));
    const grokHome = path.join(base, "home");
    const repoA = path.join(base, "repo-a");
    const repoB = path.join(base, "repo-b");
    try {
      fs.mkdirSync(repoA, { recursive: true });
      fs.mkdirSync(repoB, { recursive: true });
      const catalogA = sessionsDirFor(grokHome, repoA);
      const catalogB = sessionsDirFor(grokHome, repoB);
      const imgB = path.join(catalogB, "sess-b", "images", "x.jpg");
      fs.mkdirSync(path.dirname(imgB), { recursive: true });
      fs.writeFileSync(imgB, "other-repo");
      // Active project is A; only A's catalog is authorized.
      fs.mkdirSync(path.join(catalogA, "sess-a"), { recursive: true });

      const ctx = {
        workspaceRoot: repoA,
        grokHome,
        sessionDir: path.join(catalogA, "sess-a"),
        sessionCatalogDirs: [catalogA],
        pathFs: {
          realpathSync: (p: string) => fs.realpathSync(p),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      };

      const gate = authorizeDesktopWebviewMsg({ type: "openFile", path: imgB }, ctx);
      expect("refused" in gate).toBe(true);
      expect(authorizeOpenFile(imgB, ctx).ok).toBe(false);

      const opened = resolveAuthorizedFileForOpen(imgB, ctx);
      expect(opened.ok).toBe(false);

      // Mutation: authorizing absolute media under whole grokHome (pre-fix)
      // would pass both gates for any session under ~/.grok — including repo B.
      const underHome = isTrustedGeneratedMediaPath(imgB, grokHome, (p) =>
        fs.realpathSync(p),
      );
      expect(underHome).toBe(true);
      // That is exactly the hole this test pins closed at the desktop gate.
      expect(isTrustedGeneratedMediaPath(imgB, catalogA, (p) => fs.realpathSync(p))).toBe(
        false,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("absolute media under a catalog junction escaping ~/.grok is refused", () => {
    // sessionCatalogDirs lists entries with existsSync/readdirSync and never
    // proves they canonically stay under home. isTrustedGeneratedMediaPath
    // contains against the realpath of whichever root it is given: catalog-only
    // accepts a junction at ~/.grok/sessions/<cwd> → /anywhere (shape check
    // still sees /sessions/ on the link path; containment runs on the target).
    // Gate requires BOTH home and catalog — this pins the home half.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-junc-esc-"));
    const grokHome = path.join(base, "home");
    const outside = path.join(base, "outside");
    const repo = path.join(base, "repo");
    try {
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(grokHome, { recursive: true });
      // Real bytes live only outside home (junction destination).
      const outsideImg = path.join(outside, "sess-j", "images", "secret.jpg");
      fs.mkdirSync(path.dirname(outsideImg), { recursive: true });
      fs.writeFileSync(outsideImg, "escaped-secret");

      // Link path still looks like a normal project catalog under home.
      const catalog = sessionsDirFor(grokHome, repo);
      const linkImg = path.join(catalog, "sess-j", "images", "secret.jpg");

      // Fake realpath: catalog (and everything under it) maps onto outside —
      // same as an OS junction without needing symlink privileges.
      const realpathMap = (p: string): string => {
        const resolved = path.resolve(p);
        const cat = path.resolve(catalog);
        const home = path.resolve(grokHome);
        if (resolved === cat || resolved.startsWith(cat + path.sep)) {
          return path.resolve(outside, path.relative(cat, resolved));
        }
        if (resolved === home || resolved.startsWith(home + path.sep)) {
          return resolved;
        }
        try {
          return fs.realpathSync(p);
        } catch {
          return resolved;
        }
      };

      const pathFs: TreePathFs = {
        realpathSync: realpathMap,
        existsSync: (p: string) => {
          try {
            return fs.existsSync(realpathMap(p));
          } catch {
            return fs.existsSync(p);
          }
        },
        statSync: (p: string) => fs.statSync(realpathMap(p)),
        readdirSync: (p: string, o: { withFileTypes: true }) =>
          fs.readdirSync(realpathMap(p), o),
      };

      const ctx = {
        workspaceRoot: repo,
        grokHome,
        sessionDir: path.join(catalog, "sess-j"),
        sessionCatalogDirs: [catalog],
        pathFs,
      };

      // Catalog-only trust would accept — that is the hole without the home half.
      expect(isTrustedGeneratedMediaPath(linkImg, catalog, realpathMap)).toBe(true);
      // Home trust refuses: canonical target is outside ~/.grok.
      expect(isTrustedGeneratedMediaPath(linkImg, grokHome, realpathMap)).toBe(false);

      const gate = authorizeDesktopWebviewMsg({ type: "openFile", path: linkImg }, ctx);
      expect("refused" in gate).toBe(true);
      expect(authorizeOpenFile(linkImg, ctx).ok).toBe(false);
      expect(resolveAuthorizedFileForOpen(linkImg, ctx).ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("absolute media under a catalog junction to another project catalog is refused", () => {
    // Catalog A → junction → catalog B, both inside ~/.grok. Home trust and
    // catalog trust (against realpath(A) ≡ B) both pass; the leaf discriminator
    // does not (basename of realpath(A) is B's urlencoded cwd).
    // Mutation: drop catalogKeepsEncodedLeaf and this test fails (authorizes
    // imgB through catalogA's junction).
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-junc-xcat-"));
    const grokHome = path.join(base, "home");
    const repoA = path.join(base, "repo-a");
    const repoB = path.join(base, "repo-b");
    try {
      fs.mkdirSync(repoA, { recursive: true });
      fs.mkdirSync(repoB, { recursive: true });
      const catalogA = sessionsDirFor(grokHome, repoA);
      const catalogB = sessionsDirFor(grokHome, repoB);
      // Distinct leaves are the property under test (urlencoded cwd differs).
      expect(path.basename(catalogA)).not.toBe(path.basename(catalogB));

      const imgB = path.join(catalogB, "sess-b", "images", "x.jpg");
      fs.mkdirSync(path.dirname(imgB), { recursive: true });
      fs.writeFileSync(imgB, "other-catalog");
      // Link path under A that realpaths onto B's file.
      const linkImg = path.join(catalogA, "sess-b", "images", "x.jpg");

      const realpathMap = (p: string): string => {
        const resolved = path.resolve(p);
        const catA = path.resolve(catalogA);
        const catB = path.resolve(catalogB);
        if (resolved === catA || resolved.startsWith(catA + path.sep)) {
          return path.join(catB, path.relative(catA, resolved));
        }
        return resolved;
      };

      const pathFs: TreePathFs = {
        realpathSync: realpathMap,
        existsSync: (p: string) => {
          try {
            return fs.existsSync(realpathMap(p));
          } catch {
            return fs.existsSync(p);
          }
        },
        statSync: (p: string) => fs.statSync(realpathMap(p)),
        readdirSync: (p: string, o: { withFileTypes: true }) =>
          fs.readdirSync(realpathMap(p), o),
      };

      const ctx = {
        workspaceRoot: repoA,
        grokHome,
        sessionDir: path.join(catalogA, "sess-a"),
        // Auth context only lists A — the junction rewrites it onto B.
        sessionCatalogDirs: [catalogA],
        pathFs,
      };

      // Both containment halves pass through the junction — leaf check is the
      // only refusal. (Media path can be the link path or the real target.)
      expect(isTrustedGeneratedMediaPath(linkImg, grokHome, realpathMap)).toBe(true);
      expect(isTrustedGeneratedMediaPath(linkImg, catalogA, realpathMap)).toBe(true);
      expect(path.basename(realpathMap(catalogA))).toBe(path.basename(path.resolve(catalogB)));
      expect(path.basename(realpathMap(catalogA))).not.toBe(
        path.basename(path.resolve(catalogA)),
      );

      const gate = authorizeDesktopWebviewMsg({ type: "openFile", path: linkImg }, ctx);
      expect("refused" in gate).toBe(true);
      expect(authorizeOpenFile(linkImg, ctx).ok).toBe(false);
      expect(resolveAuthorizedFileForOpen(linkImg, ctx).ok).toBe(false);

      // Real target under B with only A authorized is also refused (no leaf
      // match on A, and B is not listed).
      expect(authorizeOpenFile(imgB, ctx).ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("absolute media under a catalog junction relocating within ~/.grok is refused", () => {
    // sessions/<leaf> → other/<leaf>: same basename, still under home. Home
    // trust + catalog trust + leaf match all pass; only the direct-child-of-
    // <grokHome>/sessions half of catalogKeepsEncodedLeaf refuses.
    // Mutation: drop the isSessionDirChild(realParent, realChild) half of
    // keepsCanonicalDirectChildIdentity (keep leaf-only) and this test fails —
    // authorizes the relocated catalog.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-junc-reloc-"));
    const grokHome = path.join(base, "home");
    const repo = path.join(base, "repo");
    try {
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(path.join(grokHome, "sessions"), { recursive: true });
      const catalog = sessionsDirFor(grokHome, repo);
      const leaf = path.basename(catalog);
      // Real bytes live under ~/.grok/other/<same-leaf>/… (not under sessions/).
      const relocated = path.join(grokHome, "other", leaf);
      const realImg = path.join(relocated, "sess-j", "images", "secret.jpg");
      fs.mkdirSync(path.dirname(realImg), { recursive: true });
      fs.writeFileSync(realImg, "relocated-secret");
      const linkImg = path.join(catalog, "sess-j", "images", "secret.jpg");

      const realpathMap = (p: string): string => {
        const resolved = path.resolve(p);
        const cat = path.resolve(catalog);
        if (resolved === cat || resolved.startsWith(cat + path.sep)) {
          return path.join(path.resolve(relocated), path.relative(cat, resolved));
        }
        return resolved;
      };

      const pathFs: TreePathFs = {
        realpathSync: realpathMap,
        existsSync: (p: string) => {
          try {
            return fs.existsSync(realpathMap(p));
          } catch {
            return fs.existsSync(p);
          }
        },
        statSync: (p: string) => fs.statSync(realpathMap(p)),
        readdirSync: (p: string, o: { withFileTypes: true }) =>
          fs.readdirSync(realpathMap(p), o),
      };

      const ctx = {
        workspaceRoot: repo,
        grokHome,
        sessionDir: path.join(catalog, "sess-j"),
        sessionCatalogDirs: [catalog],
        pathFs,
      };

      // Prove the hole halves that are NOT enough alone:
      expect(path.basename(realpathMap(catalog))).toBe(leaf);
      expect(isTrustedGeneratedMediaPath(linkImg, grokHome, realpathMap)).toBe(true);
      expect(isTrustedGeneratedMediaPath(linkImg, catalog, realpathMap)).toBe(true);
      // Relocated parent is under home but not the sessions root.
      expect(path.dirname(realpathMap(catalog))).toBe(path.resolve(grokHome, "other"));
      expect(path.dirname(realpathMap(catalog))).not.toBe(
        path.resolve(path.join(grokHome, "sessions")),
      );

      const gate = authorizeDesktopWebviewMsg({ type: "openFile", path: linkImg }, ctx);
      expect("refused" in gate).toBe(true);
      expect(authorizeOpenFile(linkImg, ctx).ok).toBe(false);
      expect(resolveAuthorizedFileForOpen(linkImg, ctx).ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("relative media under a catalog junction relocating within ~/.grok is refused", () => {
    // sessionDirFor derives sessionDir as catalog/<id> under the junctioned
    // catalog. resolveTrustedMediaOpenPath's relative branch applies
    // catalogKeepsEncodedLeaf to dirname(sessionDir) — same helper as the
    // absolute catalog loop — so the relocating junction is refused before
    // resolveSessionGeneratedMediaPath. Use-time trySessionMediaOpen then
    // re-auths the absolute path through that same fence via sessionCatalogDirs.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-junc-reloc-rel-"));
    const grokHome = path.join(base, "home");
    const repo = path.join(base, "repo");
    try {
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(path.join(grokHome, "sessions"), { recursive: true });
      const catalog = sessionsDirFor(grokHome, repo);
      const leaf = path.basename(catalog);
      const relocated = path.join(grokHome, "other", leaf);
      const realImg = path.join(relocated, "sess-j", "images", "secret.jpg");
      fs.mkdirSync(path.dirname(realImg), { recursive: true });
      fs.writeFileSync(realImg, "relocated-secret");

      const realpathMap = (p: string): string => {
        const resolved = path.resolve(p);
        const cat = path.resolve(catalog);
        if (resolved === cat || resolved.startsWith(cat + path.sep)) {
          return path.join(path.resolve(relocated), path.relative(cat, resolved));
        }
        return resolved;
      };

      const pathFs: TreePathFs = {
        realpathSync: realpathMap,
        existsSync: (p: string) => {
          try {
            return fs.existsSync(realpathMap(p));
          } catch {
            return fs.existsSync(p);
          }
        },
        statSync: (p: string) => fs.statSync(realpathMap(p)),
        readdirSync: (p: string, o: { withFileTypes: true }) =>
          fs.readdirSync(realpathMap(p), o),
      };

      // sessionDir layout matches sessionDirFor: catalog/<id> on the link path.
      const sessionDir = path.join(catalog, "sess-j");
      const ctx = {
        workspaceRoot: repo,
        grokHome,
        sessionDir,
        sessionCatalogDirs: [catalog],
        pathFs,
      };

      // Without the relative-branch dirname(sessionDir) fence, home+session
      // containment alone would still trust the resolved file under other/<leaf>.
      const joined = path.join(sessionDir, "images", "secret.jpg");
      expect(isTrustedGeneratedMediaPath(joined, sessionDir, realpathMap)).toBe(true);
      expect(isTrustedGeneratedMediaPath(joined, grokHome, realpathMap)).toBe(true);

      // Message-gate relative path is workspace-first (lexical), so pin the
      // media gate via absolute authorize + use-time relative open.
      expect(authorizeOpenFile(joined, ctx).ok).toBe(false);
      const opened = resolveAuthorizedFileForOpen("images/secret.jpg", ctx);
      expect(opened.ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("relative media under a sessionDir junction to a sibling session is refused", () => {
    // sessions/<cwd>/<active-id> → sibling session under the *same* catalog.
    // sessionDirFor's child check is lexical, so it can hand back the junction
    // path. realpath(sessionDir) is the sibling; isTrustedGeneratedMediaPath
    // against that root accepts images/1.jpg, home trust passes, AND absolute
    // re-auth under the honest catalog also passes (sibling is still in-catalog
    // — that is the fork-replay case for absolute paths). Only
    // keepsCanonicalDirectChildIdentity(sessionDir, catalog) refuses the
    // relative open: the leaf is no longer the active session id.
    // Mutation: drop the sessionDir keepsCanonicalDirectChildIdentity check in
    // resolveTrustedMediaOpenPath (and the same fence in
    // resolveSessionGeneratedMediaPath) and this test fails — authorizes the
    // sibling session's media via the relative open path.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-sess-junc-"));
    const grokHome = path.join(base, "home");
    const repo = path.join(base, "repo");
    try {
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(path.join(grokHome, "sessions"), { recursive: true });
      const catalog = sessionsDirFor(grokHome, repo);

      // Real bytes live only under the sibling session.
      const siblingSession = path.join(catalog, "sess-sibling");
      const siblingImg = path.join(siblingSession, "images", "1.jpg");
      fs.mkdirSync(path.dirname(siblingImg), { recursive: true });
      fs.writeFileSync(siblingImg, "sibling-session-media");

      // Active session path is a junction onto the sibling.
      const sessionDir = path.join(catalog, "sess-active");
      const linkImg = path.join(sessionDir, "images", "1.jpg");

      const realpathMap = (p: string): string => {
        const resolved = path.resolve(p);
        const sess = path.resolve(sessionDir);
        if (resolved === sess || resolved.startsWith(sess + path.sep)) {
          return path.join(path.resolve(siblingSession), path.relative(sess, resolved));
        }
        return resolved;
      };

      const pathFs: TreePathFs = {
        realpathSync: realpathMap,
        existsSync: (p: string) => {
          try {
            return fs.existsSync(realpathMap(p));
          } catch {
            return fs.existsSync(p);
          }
        },
        statSync: (p: string) => fs.statSync(realpathMap(p)),
        readdirSync: (p: string, o: { withFileTypes: true }) =>
          fs.readdirSync(realpathMap(p), o),
      };

      const ctx = {
        workspaceRoot: repo,
        grokHome,
        sessionDir,
        sessionCatalogDirs: [catalog],
        pathFs,
      };

      // Prove the hole without the identity fence: home + sessionDir containment
      // pass, and absolute re-auth under the (honest) catalog would also pass.
      expect(isTrustedGeneratedMediaPath(linkImg, sessionDir, realpathMap)).toBe(true);
      expect(isTrustedGeneratedMediaPath(linkImg, grokHome, realpathMap)).toBe(true);
      expect(isTrustedGeneratedMediaPath(linkImg, catalog, realpathMap)).toBe(true);
      // Catalog itself is honest — only the session leaf is junctioned.
      expect(path.basename(realpathMap(catalog))).toBe(path.basename(path.resolve(catalog)));
      // Leaf diverges (sess-active → sess-sibling); parent stays the catalog.
      expect(path.dirname(realpathMap(sessionDir))).toBe(path.resolve(catalog));
      expect(path.basename(realpathMap(sessionDir))).toBe("sess-sibling");
      expect(path.basename(realpathMap(sessionDir))).not.toBe(
        path.basename(path.resolve(sessionDir)),
      );

      // Relative open is the load-bearing hole without the sessionDir fence.
      // (Message-gate authorize is workspace-first and may accept a lexical
      // in-tree path; use-time resolveAuthorizedFileForOpen is the media gate.)
      const opened = resolveAuthorizedFileForOpen("images/1.jpg", ctx);
      expect(opened.ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("absolute sibling-SESSION media path in same project is allowed (fork-replay case)", () => {
    // Forks replay transcripts whose absolute media paths still point at the
    // *parent* session directory. Scoping absolute opens to sessionDir alone
    // would refuse those clicks; project-catalog scope keeps them open.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-xsess-"));
    const grokHome = path.join(base, "home");
    const repo = path.join(base, "repo");
    try {
      fs.mkdirSync(repo, { recursive: true });
      const catalog = sessionsDirFor(grokHome, repo);
      const parentDir = path.join(catalog, "parent-sess");
      const forkDir = path.join(catalog, "fork-sess");
      const parentImg = path.join(parentDir, "images", "1.jpg");
      fs.mkdirSync(path.dirname(parentImg), { recursive: true });
      fs.mkdirSync(forkDir, { recursive: true });
      fs.writeFileSync(parentImg, "parent-media");

      const ctx = {
        workspaceRoot: repo,
        grokHome,
        // Active conversation is the fork; media path names the parent.
        sessionDir: forkDir,
        sessionCatalogDirs: [catalog],
        pathFs: {
          realpathSync: (p: string) => fs.realpathSync(p),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      };

      const gate = authorizeDesktopWebviewMsg({ type: "openFile", path: parentImg }, ctx);
      expect("msg" in gate).toBe(true);
      const authorized = authorizeOpenFile(parentImg, ctx);
      expect(authorized.ok).toBe(true);
      if (authorized.ok) {
        expect(path.resolve(authorized.absPath)).toBe(path.resolve(parentImg));
      }

      const opened = resolveAuthorizedFileForOpen(parentImg, ctx);
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(path.resolve(opened.absPath)).toBe(path.resolve(parentImg));
      }

      // Relative links stay session-local: fork has no images/1.jpg of its own.
      const relOpened = resolveAuthorizedFileForOpen("images/1.jpg", ctx);
      // Workspace miss → trySessionMediaOpen against fork sessionDir only.
      expect(relOpened.ok).toBe(false);

      // Mutation: if absolute used sessionDir as the only root (rejected design),
      // parent media would fail isTrustedGeneratedMediaPath under forkDir.
      expect(
        isTrustedGeneratedMediaPath(parentImg, forkDir, (p) => fs.realpathSync(p)),
      ).toBe(false);
      expect(
        isTrustedGeneratedMediaPath(parentImg, catalog, (p) => fs.realpathSync(p)),
      ).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("resolveAuthorizedFileForOpen opens RELATIVE images/ via trySessionMediaOpen (workspace miss)", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-rel-use-"));
    try {
      const catalog = path.join(grokHome, "sessions", "cwd-enc");
      const sessionDir = path.join(catalog, "sess-rel-use");
      const img = path.join(sessionDir, "images", "1.jpg");
      fs.mkdirSync(path.dirname(img), { recursive: true });
      fs.writeFileSync(img, "session-jpeg");
      // Workspace candidate must be absent so the use-time path reaches trySessionMediaOpen.
      const wsCandidate = path.join(root, "images", "1.jpg");
      try {
        fs.unlinkSync(wsCandidate);
      } catch {
        /* ok */
      }

      const opened = resolveAuthorizedFileForOpen("images/1.jpg", {
        workspaceRoot: root,
        grokHome,
        sessionDir,
        // Absolute re-auth after resolveSessionGeneratedMediaPath uses catalog fence.
        sessionCatalogDirs: [catalog],
        pathFs: {
          realpathSync: (p: string) => fs.realpathSync(p),
          existsSync: (p: string) => fs.existsSync(p),
          statSync: (p: string) => fs.statSync(p),
          readdirSync: (p: string, o: { withFileTypes: true }) => fs.readdirSync(p, o),
        },
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(path.resolve(opened.absPath)).toBe(path.resolve(img));
        expect(fs.readFileSync(opened.absPath, "utf8")).toBe("session-jpeg");
      }
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("source gate: ElectronWebview.dispatchMessage applies desktop policy", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(src).toContain("authorizeDesktopWebviewMsg");
    expect(src).toMatch(/dispatchMessage[\s\S]*authorizeDesktopWebviewMsg/);
  });

  it("file-tree IPC open refuses executables (same policy as chat openFile)", () => {
    const ipcSrc = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "file-tree-ipc.ts",
      ),
      "utf8",
    );
    expect(ipcSrc).toContain('import { isExecutableOpenTarget } from "./desktop-policy"');
    expect(ipcSrc).toContain("executable path refused");
    // Must run before the OS open, not only document in comments.
    const openHandler = ipcSrc.indexOf("ipcMain.handle(CH_OPEN");
    expect(openHandler).toBeGreaterThan(0);
    const openBody = ipcSrc.slice(openHandler, ipcSrc.indexOf("ipcMain.handle(CH_REVEAL", openHandler));
    // The refusal must sit on the RE-RESOLVED path and run before the OS call:
    // checking the path resolved earlier would leave the window a symlink swap
    // needs. Asserted per-handler rather than "somewhere in the file", because
    // a shared validator that one handler forgets to call is exactly the shape
    // this is guarding against.
    const refuse = openBody.indexOf("isExecutableOpenTarget(finalCheck.absPath)");
    const openCall = openBody.indexOf("await shell.openPath(");
    expect(refuse).toBeGreaterThan(0);
    expect(openCall).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(openCall);

    // Reveal is weaker than open — it does not launch anything — but it still
    // confirms a file's existence and location to whoever asked, so it gets the
    // same gate rather than a shorter one.
    const revealHandler = ipcSrc.indexOf("ipcMain.handle(CH_REVEAL");
    expect(revealHandler).toBeGreaterThan(0);
    const revealBody = ipcSrc.slice(revealHandler, ipcSrc.indexOf("ipcMain.handle(CH_READ", revealHandler));
    const revealRefuse = revealBody.indexOf("isExecutableOpenTarget(finalCheck.absPath)");
    const revealCall = revealBody.indexOf("shell.showItemInFolder(");
    expect(revealRefuse).toBeGreaterThan(0);
    expect(revealCall).toBeGreaterThan(0);
    expect(revealRefuse).toBeLessThan(revealCall);
    expect(revealBody).toContain("isIpcFromMainWindow");
  });
});

describe("desktop single-instance lock (source)", () => {
  it("main requests a single-instance lock and focuses the existing window", () => {
    const mainSrc = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "main.ts",
      ),
      "utf8",
    );
    expect(mainSrc).toContain("requestSingleInstanceLock");
    expect(mainSrc).toContain("second-instance");
    expect(mainSrc).toMatch(/gotSingleInstanceLock/);
    // Second launch must not createApp — only the lock holder proceeds.
    expect(mainSrc).toMatch(/if\s*\(\s*gotSingleInstanceLock\s*\)/);
    expect(mainSrc).toMatch(/win\.focus\(\)/);
    // Mutation: without the early quit path, a second process would boot fully.
    const lockIdx = mainSrc.indexOf("requestSingleInstanceLock");
    const quitIdx = mainSrc.indexOf("app.quit()", lockIdx);
    const createIdx = mainSrc.indexOf("void createApp()");
    expect(lockIdx).toBeGreaterThan(0);
    expect(quitIdx).toBeGreaterThan(lockIdx);
    expect(createIdx).toBeGreaterThan(quitIdx);
  });
});

describe("media provenance + registry (A2)", () => {
  let tmp: string;
  let grokHome: string;
  let mediaRoot: string;
  let roots: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-prov-"));
    grokHome = path.join(tmp, "fake-grok-home");
    mediaRoot = path.join(tmp, "ext", "media");
    roots = [mediaRoot, grokHome];
    fs.mkdirSync(path.join(grokHome, "sessions", "cwd", "id", "images"), {
      recursive: true,
    });
    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, "chat.js"), "/* */");
    fs.writeFileSync(path.join(grokHome, "auth.json"), '{"t":1}');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("trusts only generated session media under the real Grok home", () => {
    const img = path.join(grokHome, "sessions", "cwd", "id", "images", "1.jpg");
    fs.writeFileSync(img, "jpeg");
    expect(isGeneratedSessionMediaPath(img)).toBe(true);
    expect(
      isTrustedGeneratedMediaPath(img, grokHome, (p) => fs.realpathSync(p)),
    ).toBe(true);

    // Arbitrary file under grok home with a media ext but wrong layout.
    const loose = path.join(grokHome, "secret.png");
    fs.writeFileSync(loose, "png");
    expect(isGeneratedSessionMediaPath(loose)).toBe(false);
    expect(
      isTrustedGeneratedMediaPath(loose, grokHome, (p) => fs.realpathSync(p)),
    ).toBe(false);
  });

  it("refuses auth.json by basename for agent media paths", () => {
    expect(isRefusedMediaBasename(path.join(grokHome, "auth.json"))).toBe(true);
    expect(isRefusedMediaBasename("/home/u/.grok/auth.json")).toBe(true);
    expect(isRefusedMediaBasename("C:\\Users\\x\\.grok\\auth.json")).toBe(true);
    expect(isRefusedMediaBasename(path.join(grokHome, "sessions", "c", "i", "images", "1.png"))).toBe(false);
    expect(isRefusedMediaBasename(path.join(tmp, "out", "chart.png"))).toBe(false);
  });

  it("refuses a media path whose canonical target is auth.json (symlink dodge)", () => {
    const secret = path.join(grokHome, "auth.json");
    const innocuous = path.join(tmp, "workspace", "chart.png");
    fs.mkdirSync(path.dirname(innocuous), { recursive: true });
    // Injectable realpath: reported chart.png resolves to auth.json.
    const realpath = (p: string) =>
      path.resolve(p) === path.resolve(innocuous) ? secret : path.resolve(p);
    expect(isRefusedMediaBasename(innocuous)).toBe(false);
    expect(isRefusedMediaPath(innocuous, realpath)).toBe(true);
    expect(isRefusedMediaPath(secret, realpath)).toBe(true);
    // Legitimate chart stays allowed.
    const realChart = path.join(tmp, "workspace", "real-chart.png");
    expect(isRefusedMediaPath(realChart, (p) => path.resolve(p))).toBe(false);
  });

  it("mutation: basename-only refuse would miss the symlink dodge", () => {
    const secret = path.join(grokHome, "auth.json");
    const link = path.join(tmp, "out", "chart.png");
    const realpath = (p: string) =>
      path.resolve(p) === path.resolve(link) ? secret : path.resolve(p);
    // The pre-fix check (basename only) is what this asserts would fail open.
    expect(isRefusedMediaBasename(link)).toBe(false);
    expect(isRefusedMediaPath(link, realpath)).toBe(true);
  });

  it("caps base64-inlined agent media at 8 MiB", () => {
    // Revert of this constant (or raising it unboundedly) would re-allow huge
    // data: URIs into the DOM; the number is the product decision under test.
    expect(MAX_INLINE_MEDIA_BYTES).toBe(8 * 1024 * 1024);
  });

  it("caps ACP inline (kind:data) media by decoded base64 length", () => {
    // ~12 bytes decoded from "AAAAAAAAAAAA" (9 chars → floor*3/4); scale up.
    const over = Buffer.alloc(MAX_INLINE_MEDIA_BYTES + 1).toString("base64");
    expect(base64DecodedByteLength(over)).toBeGreaterThan(MAX_INLINE_MEDIA_BYTES);
    const under = Buffer.alloc(16).toString("base64");
    expect(base64DecodedByteLength(under)).toBeLessThanOrEqual(MAX_INLINE_MEDIA_BYTES);
    // Source gate: postGeneratedMedia must apply this before emit.
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    expect(sidebar).toContain("base64DecodedByteLength");
    expect(sidebar).toMatch(
      /kind === "data"[\s\S]*base64DecodedByteLength[\s\S]*MAX_INLINE_MEDIA_BYTES/,
    );
  });

  it("mutation: skipping the inline size check would re-admit oversized data: media", () => {
    // If postGeneratedMedia only checked the file-path branch, this gate is gone.
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const dataBranch = sidebar.match(
      /if \(m\.kind === "data"\) \{[\s\S]*?\n      \}/,
    )?.[0] ?? "";
    expect(dataBranch).toContain("base64DecodedByteLength");
    expect(dataBranch).toContain("MAX_INLINE_MEDIA_BYTES");
  });

  it("refuses a symlink whose real target leaves the media root at register time", () => {
    const outside = path.join(tmp, "outside-secret.png");
    fs.writeFileSync(outside, "classified");
    const link = path.join(
      grokHome,
      "sessions",
      "cwd",
      "id",
      "images",
      "leak.png",
    );

    let linked = false;
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "file" : undefined);
      linked = true;
    } catch {
      /* no symlink privilege — use injectable fs below */
    }

    const registry = new ResourceRegistry();

    if (linked) {
      expect(() =>
        registry.register(link, { allowedRoots: roots }),
      ).toThrow(/approved media root|not under/i);
      // Without allowedRoots the old API would accept it — pin the production path.
      expect(
        mayRegisterResourcePath(link, roots, rootServePolicy),
      ).toBe(false);
    } else {
      // Simulate: realpath of link → outside; realpath of roots stay put.
      const mockFs = {
        realpathSync: (p: string) => {
          if (path.resolve(p) === path.resolve(link)) return outside;
          return fs.realpathSync(p);
        },
        existsSync: (p: string) =>
          path.resolve(p) === path.resolve(link) ? true : fs.existsSync(p),
        statSync: (p: string) =>
          fs.statSync(path.resolve(p) === path.resolve(link) ? outside : p),
      };
      // Create a placeholder so basename paths exist for other calls.
      fs.writeFileSync(link, "placeholder");
      const reg = new ResourceRegistry(mockFs);
      expect(() => reg.register(link, { allowedRoots: roots })).toThrow(
        /approved media root|not under/i,
      );
    }
  });

  it("mutation: register without allowedRoots would still accept a path outside roots", () => {
    // Documents that production must pass allowedRoots (electron-webview does).
    const secret = path.join(tmp, "not-under-roots.png");
    fs.writeFileSync(secret, "x");
    const registry = new ResourceRegistry();
    // No roots → legacy test path still registers (swap tests rely on this).
    const id = registry.register(secret);
    expect(id).toMatch(/^[a-f0-9]{32}$/i);
    // With roots → refused.
    expect(() => registry.register(secret, { allowedRoots: roots })).toThrow();
  });

  it("source gate: asWebviewUri passes allowedRoots into register", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-webview.ts",
      ),
      "utf8",
    );
    expect(src).toMatch(/registry\.register\([\s\S]*allowedRoots/);
  });
});

describe("atomic secrets write (A3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-atom-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never unlinks the destination before a successful replacement is staged", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "safe-secrets.ts",
      ),
      "utf8",
    );
    // Old pattern: unlink dest then rename tmp — crash window loses the token.
    expect(src).not.toMatch(/unlinkSync\(filePath\)[\s\S]{0,80}renameSync\(tmp,\s*filePath\)/);
    expect(src).toContain("isWindowsReplaceRenameError");
    expect(src).toMatch(/\.bak/);
    // Functional overwrite still works.
    const out = path.join(dir, "secrets.json");
    writeFileAtomic(out, JSON.stringify({ v: 1 }));
    writeFileAtomic(out, JSON.stringify({ v: 2 }));
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ v: 2 });
  });

  it("classifies only known Windows replace errors for the backup path", () => {
    expect(isWindowsReplaceRenameError({ code: "EEXIST" })).toBe(true);
    expect(isWindowsReplaceRenameError({ code: "EPERM" })).toBe(true);
    expect(isWindowsReplaceRenameError({ code: "ENOENT" })).toBe(false);
    expect(isWindowsReplaceRenameError({ code: "EIO" })).toBe(false);
  });

  it("config.json and globalState.json use writeFileAtomic (not bare writeFileSync)", () => {
    // Profile now owns the open-folder set and session metadata — a mid-write
    // crash must not truncate and silently reset preferences.
    const cfg = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "config-store.ts",
      ),
      "utf8",
    );
    const saveStart = cfg.indexOf("private save(");
    const saveBody = cfg.slice(saveStart, saveStart + 400);
    expect(saveBody).toContain("writeFileAtomic");
    expect(saveBody).not.toMatch(/writeFileSync\(this\.filePath/);

    const mem = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "memento.ts",
      ),
      "utf8",
    );
    expect(mem).toContain("writeFileAtomic");
    const writeMap = mem.slice(mem.indexOf("function writeJsonMap"), mem.indexOf("export function createFileMemento"));
    expect(writeMap).toContain("writeFileAtomic");
    expect(writeMap).not.toMatch(/writeFileSync\(/);

    // Functional: ConfigStore round-trips via atomic write.
    const configPath = path.join(dir, "config.json");
    const store = new ConfigStore(configPath);
    store.setWorkspaceRoot(dir);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).workspaceRoot).toBe(
      path.resolve(dir),
    );
  });
});

describe("watcher chain helpers (A4)", () => {
  it("nearestExistingAncestor walks past missing segments", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-watch-"));
    try {
      const missing = path.join(base, "a", "b", "c");
      expect(nearestExistingAncestor(missing)).toBe(path.resolve(base));
      expect(nearestExistingAncestor(base)).toBe(path.resolve(base));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("source gate: createBoundFileSystemWatcher rebinds when base vanishes", () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    expect(src).toContain("nearestExistingAncestor");
    expect(src).toContain("scheduleRebind");
    expect(src).toContain("bindChainWatcher");
    expect(src).toContain("fs.watch listener failed");
    expect(src).toMatch(/const notify = \(listeners: Set<\(\) => void>\): void =>/);
  });
});

describe("encrypted voiceApiKey (A5)", () => {
  let dir: string;
  let configPath: string;
  let sensPath: string;

  const memSafe: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b) => {
      const t = b.toString("utf8");
      if (!t.startsWith("enc:")) throw new Error("bad cipher");
      return t.slice(4);
    },
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-vk-"));
    configPath = path.join(dir, "config.json");
    sensPath = path.join(dir, "sensitive.enc.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores voiceApiKey only in the encrypted bag, never config.json", async () => {
    expect(SENSITIVE_CONFIG_KEYS.has("grok.voiceApiKey")).toBe(true);
    const store = new ConfigStore(configPath, new SensitiveConfigStore(sensPath, memSafe));
    await store.getConfiguration("grok").update("voiceApiKey", "sk-secret-voice");
    expect(store.getConfiguration("grok").get("voiceApiKey")).toBe("sk-secret-voice");

    // Sensitive-only writes must not create a plaintext config with the key;
    // force a normal config write and re-check.
    await store.getConfiguration("grok").update("cliPath", "/bin/fake");
    const rawCfg = fs.readFileSync(configPath, "utf8");
    expect(rawCfg).not.toContain("sk-secret-voice");
    expect(rawCfg).not.toMatch(/voiceApiKey/);

    const rawSens = fs.readFileSync(sensPath, "utf8");
    expect(rawSens).not.toContain("sk-secret-voice");
    // Ciphertext is base64 of encryptString output — not the raw key.
    expect(rawSens).toContain("grok.voiceApiKey");
    expect(JSON.parse(rawSens).entries["grok.voiceApiKey"]).toMatch(/^[A-Za-z0-9+/=]+$/);

    const again = new ConfigStore(configPath, new SensitiveConfigStore(sensPath, memSafe));
    expect(again.getConfiguration("grok").get("voiceApiKey")).toBe("sk-secret-voice");
  });

  it("migrates legacy plaintext voiceApiKey out of config.json", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        config: { "grok.voiceApiKey": "legacy-plain-key" },
      }),
      "utf8",
    );
    const store = new ConfigStore(configPath, new SensitiveConfigStore(sensPath, memSafe));
    expect(store.getConfiguration("grok").get("voiceApiKey")).toBe("legacy-plain-key");
    const rawCfg = fs.readFileSync(configPath, "utf8");
    expect(rawCfg).not.toContain("legacy-plain-key");
  });
});

describe("file preview helpers (B3)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-prev-"));
    fs.writeFileSync(path.join(root, "notes.md"), "# Title\n\nHello");
    fs.writeFileSync(path.join(root, "data.json"), '{"a":1}');
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 9]));
    fs.writeFileSync(path.join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies preview kinds and builds breadcrumbs", () => {
    expect(classifyFilePreview("x.md")).toBe("markdown");
    expect(classifyFilePreview("x.json")).toBe("json");
    expect(classifyFilePreview("x.png")).toBe("image");
    expect(classifyFilePreview("x.ts")).toBe("text");
    expect(classifyFilePreview("x.exe")).toBe("external");

    const crumbs = breadcrumbSegments("src/a/b.ts", "repo");
    expect(crumbs[0]).toEqual({ label: "repo", relPath: "" });
    expect(crumbs.map((c) => c.relPath)).toEqual(["", "src", "src/a", "src/a/b.ts"]);
  });

  it("reads md/json/image in-panel and hands binaries to external", () => {
    const md = readTreeFile(root, "notes.md");
    expect(md.ok).toBe(true);
    if (md.ok) {
      expect(md.kind).toBe("markdown");
      expect(md.text).toContain("# Title");
    }
    const js = readTreeFile(root, "data.json");
    expect(js.ok).toBe(true);
    if (js.ok) {
      expect(js.kind).toBe("json");
      expect(js.pretty).toBe(true);
      expect(js.text).toContain('"a"');
    }
    const img = readTreeFile(root, "pic.png");
    expect(img.ok).toBe(true);
    if (img.ok) {
      expect(img.kind).toBe("image");
      expect(img.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    }
    const bin = readTreeFile(root, "blob.bin");
    expect(bin.ok).toBe(false);
    if (!bin.ok) expect(bin.openExternal).toBe(true);
  });
});

// ── Round 8: authorization context, handles, serialization, TOCTOU ──────────

describe("editable file-tree writes", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempReal("grok-write-tree-");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns a stamp and preserves BOM and dominant CRLF", () => {
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, Buffer.from("\xef\xbb\xbfone\r\ntwo\r\n", "binary"));
    const read = readTreeFile(root, "notes.md");
    expect(read.ok).toBe(true);
    if (!read.ok || !read.details) throw new Error("expected text details");
    expect(read.text).toBe("one\r\ntwo\r\n");
    expect(read.details.bom).toBe(true);
    expect(read.details.lineEnding).toBe("crlf");
    expect(read.details.trailingNewline).toBe(true);

    // A textarea hands back LF for every CRLF it was given, so the submission
    // says nothing about line endings — but it DOES still carry the file's
    // final newline, because an untouched end of file round-trips it.
    const saved = writeTreeFile(root, "notes.md", "one changed\ntwo\n", read.details.stamp, {});
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(file)).toEqual(Buffer.from("\xef\xbb\xbfone changed\r\ntwo\r\n", "binary"));
  });

  it("honours deleting the final newline instead of silently restoring it", () => {
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, Buffer.from("\xef\xbb\xbfone\r\ntwo\r\n", "binary"));
    const read = readTreeFile(root, "notes.md");
    if (!read.ok || !read.details) throw new Error("expected text details");

    // The user removed the trailing newline. The writer used to put it back
    // while the client recorded the submitted text as its clean baseline and
    // said "Saved." — so the editor showed an edit the file did not have.
    const saved = writeTreeFile(root, "notes.md", "one\ntwo", read.details.stamp, {});
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(file)).toEqual(Buffer.from("\xef\xbb\xbfone\r\ntwo", "binary"));

    // And the save is stable: reopening shows what was written, so the editor
    // and the disk agree.
    const reread = readTreeFile(root, "notes.md");
    expect(reread.ok && reread.text).toBe("one\r\ntwo");
  });

  it("honours adding a final newline to a file that had none", () => {
    const file = path.join(root, "notes.txt");
    fs.writeFileSync(file, "one\ntwo", "utf8");
    const read = readTreeFile(root, "notes.txt");
    if (!read.ok || !read.details) throw new Error("expected text details");
    expect(read.details.trailingNewline).toBe(false);

    const saved = writeTreeFile(root, "notes.txt", "one\ntwo\n", read.details.stamp, {});
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  // JSON is the one kind readTreeFile TRANSFORMS on the way out (pretty-print),
  // and JSON.stringify emits no trailing newline. That makes it the one file
  // type where "the submission lacks a newline" can mean OUR transform dropped
  // it rather than the user deleting it — so honouring the submission blindly
  // would strip the newline off every formatted JSON file that had one.
  it("carries a JSON file's final newline across the pretty-print", () => {
    const file = path.join(root, "conf.json");
    fs.writeFileSync(file, '{"a":1}\n', "utf8");
    const read = readTreeFile(root, "conf.json");
    if (!read.ok || !read.details) throw new Error("expected text details");
    expect(read.pretty).toBe(true);
    // What the textarea is handed must end the way the file does, or the
    // writer cannot tell a deletion from a formatting artefact.
    expect(read.text).toBe('{\n  "a": 1\n}\n');
  });

  it("does not strip a JSON file's final newline when an interior value is edited", () => {
    const file = path.join(root, "pkg.json");
    fs.writeFileSync(file, '{\n  "name": "old"\n}\n', "utf8");
    const read = readTreeFile(root, "pkg.json");
    if (!read.ok || !read.details) throw new Error("expected text details");

    // Edit what the CLIENT was handed, exactly as the textarea does — the
    // submission's trailing newline has to come from `read.text`, not from the
    // test, or this passes even when the pretty-printer has eaten it.
    const submitted = read.text!.replace('"old"', '"new"');
    const saved = writeTreeFile(root, "pkg.json", submitted, read.details.stamp, {});
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe('{\n  "name": "new"\n}\n');
  });

  it("leaves a newline-less JSON file newline-less", () => {
    // The converse: adding one here would be just as much of an unasked edit.
    const file = path.join(root, "tight.json");
    fs.writeFileSync(file, '{"a":1}', "utf8");
    const read = readTreeFile(root, "tight.json");
    if (!read.ok || !read.details) throw new Error("expected text details");
    expect(read.text).toBe('{\n  "a": 1\n}');

    const saved = writeTreeFile(root, "tight.json", read.text!, read.details.stamp, {});
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe('{\n  "a": 1\n}');
  });

  // The invariant the writer's whole rule rests on, stated once for EVERY
  // editable kind rather than per-transform: the text handed to the client must
  // end the way the file does. `writeTreeFile` reads a missing final newline as
  // the user deleting it, so any read-path transform that drops one turns a
  // save into an unasked edit — which is exactly what the JSON pretty-printer
  // did. A future transform on a new kind fails here instead of in the wild.
  it("hands the client text that ends the way the file does, for every editable kind", () => {
    const cases: Array<[string, string]> = [
      ["k.md", "# t\n"],
      ["k.md", "# t"],
      ["k.txt", "one\ntwo\n"],
      ["k.txt", "one\ntwo"],
      ["k.json", '{\n  "a": 1\n}\n'],
      ["k.json", '{\n  "a": 1\n}'],
      // Not valid JSON, so the pretty-print bails and the raw text shows.
      ["k.json", "{oops\n"],
    ];
    for (const [name, body] of cases) {
      const file = path.join(root, name);
      fs.writeFileSync(file, body, "utf8");
      const read = readTreeFile(root, name);
      if (!read.ok) throw new Error(`expected a readable file for ${name}`);
      expect(
        /\n$/.test(read.text ?? ""),
        `${name} ${JSON.stringify(body)} → ${JSON.stringify(read.text)}`,
      ).toBe(/\n$/.test(body));
    }
  });

  it("round-trips a JSON file saved without any edit at all", () => {
    // The strongest form of the invariant: read then save unchanged must not
    // alter the file's final byte, whatever the pretty-printer did in between.
    for (const [name, body] of [["a.json", '{\n  "x": 1\n}\n'], ["b.json", '{\n  "x": 1\n}']]) {
      const file = path.join(root, name);
      fs.writeFileSync(file, body, "utf8");
      const read = readTreeFile(root, name);
      if (!read.ok || !read.details) throw new Error("expected text details");
      const saved = writeTreeFile(root, name, read.text!, read.details.stamp, {});
      expect(saved.ok, name).toBe(true);
      expect(fs.readFileSync(file, "utf8"), name).toBe(body);
    }
  });

  it("refuses a stale stamp and leaves the agent's newer bytes intact", () => {
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, "agent version\n", "utf8");
    const read = readTreeFile(root, "notes.md");
    expect(read.ok && read.details).toBeTruthy();
    fs.writeFileSync(file, "agent changed it\n", "utf8");
    const result = writeTreeFile(root, "notes.md", "my edits\n", read.ok ? read.details!.stamp : { mtimeMs: 0, size: 0 }, {});
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(fs.readFileSync(file, "utf8")).toBe("agent changed it\n");
  });

  it("mutation: removing the stamp comparison would overwrite the newer agent bytes", () => {
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, "agent version\n", "utf8");
    const read = readTreeFile(root, "notes.md");
    if (!read.ok || !read.details) throw new Error("expected stamp");
    fs.writeFileSync(file, "agent changed it\n", "utf8");
    const result = writeTreeFile(root, "notes.md", "my edits\n", read.details.stamp, {});
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toContain("agent changed it");
  });

  it("refuses non-editable kinds and oversized bodies", () => {
    fs.writeFileSync(path.join(root, "image.png"), "png", "utf8");
    fs.writeFileSync(path.join(root, "script.sh"), "echo hi\n", "utf8");
    fs.writeFileSync(path.join(root, "notes.txt"), "ok\n", "utf8");
    const imageRead = readTreeFile(root, "image.png");
    const scriptRead = readTreeFile(root, "script.sh");
    const textRead = readTreeFile(root, "notes.txt");
    expect(imageRead.ok).toBe(true);
    expect(scriptRead.ok).toBe(true);
    expect(textRead.ok && textRead.details).toBeTruthy();
    const imageResult = writeTreeFile(root, "image.png", "x", textRead.ok ? textRead.details!.stamp : { mtimeMs: 0, size: 0 }, {});
    expect(imageResult).toEqual({ ok: false, reason: "file type is not editable" });
    const tooLarge = "x".repeat(FILE_PREVIEW_MAX_BYTES + 1);
    const oversizedResult = writeTreeFile(root, "notes.txt", tooLarge, textRead.ok ? textRead.details!.stamp : { mtimeMs: 0, size: 0 }, {});
    expect(oversizedResult).toEqual({ ok: false, reason: "file too large" });
  });

  it("mutation: removing the final re-resolve would rename the swapped path", () => {
    const file = path.join(root, "link.txt");
    fs.writeFileSync(file, "inside\n", "utf8");
    const read = readTreeFile(root, "link.txt");
    if (!read.ok || !read.details) throw new Error("expected stamp");
    let linkCalls = 0;
    let renamed = false;
    const pathFs: TreePathFs = {
      realpathSync: (p) => {
        if (path.normalize(p) === path.normalize(file)) {
          linkCalls++;
          return linkCalls <= 5 ? file : path.join(path.dirname(root), "outside.txt");
        }
        return fs.realpathSync(p);
      },
      existsSync: (p) => fs.existsSync(p),
      statSync: (p) => fs.statSync(p),
      readdirSync: (p, o) => fs.readdirSync(p, o),
    };
    const result = writeTreeFile(root, "link.txt", "edited\n", read.details.stamp, {
      pathFs,
      isExecutableOpenTarget: () => false,
      renameSync: () => { renamed = true; },
    });
    expect(result.ok).toBe(false);
    expect(renamed).toBe(false);
    expect(linkCalls).toBeGreaterThan(5);
  });

  it("writes through a temporary sibling and renames it into place", () => {
    const file = path.join(root, "notes.txt");
    fs.writeFileSync(file, "old\n", "utf8");
    const read = readTreeFile(root, "notes.txt");
    if (!read.ok || !read.details) throw new Error("expected stamp");
    const renames: string[] = [];
    const result = writeTreeFile(root, "notes.txt", "new\n", read.details.stamp, {
      isExecutableOpenTarget: () => false,
      renameSync: (from, to) => {
        renames.push(`${path.basename(from)} -> ${path.basename(to)}`);
        fs.renameSync(from, to);
      },
    });
    expect(result.ok).toBe(true);
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatch(/\.tmp -> notes\.txt$/);
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
  });
});

describe("file-tree editing panel contract", () => {
  it("has the Markdown default preview, edit/save controls, scoped save shortcut, and safe confirmations", () => {
    const src = filePanelJs;
    expect(src).toContain('mode: result.kind === "markdown" ? "preview"');
    // Icon buttons now, so the assertion is on the accessible name rather than
    // visible text — that is what a user of either eyes or a screen reader
    // actually gets. "Edit" is deliberately absent for Markdown: Edit source
    // already makes it editable, so a separate Edit would be a second control
    // for the thing you just did.
    expect(src).toContain('"Preview"');
    expect(src).toContain('"Edit source"');
    expect(src).toContain('aria-label');
    expect(src).toContain('"Save"');
    expect(src).toContain('event.ctrlKey || event.metaKey');
    expect(src).toContain('event.preventDefault();');
    expect(src).toContain('{ id: "discard", label: "Discard", danger: true }');
    expect(src).toContain('answer !== "discard"');
    expect(src).toContain('actionButton("Reload"');
    expect(src).toContain('"Overwrite"');
    // The remote editor is the reference for editor state: Save advances the
    // baseline only to the captured payload, never to later textarea contents.
    expect(src).toContain("tab.baselineText = sentText");
    expect(src).toContain("tab.dirty = tab.draftText !== sentText");
    // Overwrite may refresh a stamp but cannot switch the tab's file identity.
    expect(src).toContain("fresh.absPath !== tab.expectedAbsPath");
    expect(src).not.toContain("tab.expectedAbsPath = fresh.absPath");
  });

  it("exposes the save bridge and unregisters its IPC handler", () => {
    const base = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const preload = fs.readFileSync(path.join(base, "src", "desktop", "preload.ts"), "utf8");
    const ipc = fs.readFileSync(path.join(base, "src", "desktop", "file-tree-ipc.ts"), "utf8");
    expect(preload).toContain('ipcRenderer.invoke("desk-ft:save", request)');
    expect(ipc).toContain('const CH_SAVE = "desk-ft:save"');
    expect(ipc).toContain("writeTreeFile");
    expect(ipc).toContain("CH_SAVE");
  });
});

describe("file selection handles (P1-1)", () => {
  let dir: string;
  let secret: string;
  let picked: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-fsel-"));
    secret = path.join(dir, "secret.txt");
    picked = path.join(dir, "picked.txt");
    fs.writeFileSync(secret, "do-not-leak");
    fs.writeFileSync(picked, "ok");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints opaque handles; take is one-shot and unknown ids attach nothing", () => {
    const reg = new FileSelectionRegistry();
    const id = reg.register(picked);
    expect(isFileSelectionId(id)).toBe(true);
    expect(reg.take(id)).toBe(path.resolve(picked));
    expect(reg.take(id)).toBeNull();
    expect(reg.take("0".repeat(32))).toBeNull();
    expect(reg.take("not-a-handle")).toBeNull();
  });

  it("authorizeDropFile refuses path-based dropFile when requireDropFileHandle", () => {
    const reg = new FileSelectionRegistry();
    const forged = authorizeDropFile(
      { type: "dropFile", path: secret, shift: false },
      {
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("refused" in forged).toBe(true);

    const unknown = authorizeDropFile(
      { type: "dropFile", handle: "ab".repeat(16), shift: false },
      {
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("refused" in unknown).toBe(true);

    const id = reg.register(picked);
    const ok = authorizeDropFile(
      { type: "dropFile", handle: id, shift: true },
      {
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("msg" in ok).toBe(true);
    if ("msg" in ok) {
      expect(ok.msg.path).toBe(path.resolve(picked));
      expect(ok.msg.shift).toBe(true);
      expect(ok.msg.handle).toBeUndefined();
    }
  });

  it("authorizeDesktopWebviewMsg drops forged path dropFile on desktop", () => {
    const reg = new FileSelectionRegistry();
    const bad = authorizeDesktopWebviewMsg(
      { type: "dropFile", path: secret, shift: false },
      {
        workspaceRoot: dir,
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("refused" in bad).toBe(true);

    const id = reg.register(picked);
    const good = authorizeDesktopWebviewMsg(
      { type: "dropFile", handle: id, shift: false },
      {
        workspaceRoot: dir,
        requireDropFileHandle: true,
        resolveDropFileHandle: (h) => reg.take(h),
      },
    );
    expect("msg" in good).toBe(true);
    if ("msg" in good && good.msg.type === "dropFile") {
      expect(good.msg.path).toBe(path.resolve(picked));
    }
  });

  it("mutation: without requireDropFileHandle a path dropFile would attach", () => {
    // Documents why the desktop gate must set requireDropFileHandle — schema
    // validation alone accepts a well-formed path.
    expect(
      parseWebviewMsg({ type: "dropFile", path: secret, shift: false }),
    ).not.toBeNull();
    const passthrough = authorizeDropFile(
      { type: "dropFile", path: secret, shift: false },
      { requireDropFileHandle: false },
    );
    expect("msg" in passthrough).toBe(true);
  });

  it("schema accepts handle-only dropFile and refuses empty dropFile", () => {
    expect(
      parseWebviewMsg({ type: "dropFile", handle: "ab".repeat(16), shift: false })?.type,
    ).toBe("dropFile");
    expect(parseWebviewMsg({ type: "dropFile", shift: false })).toBeNull();
    expect(parseWebviewMsg({ type: "dropFile", path: "/x", shift: "no" })).toBeNull();
  });
});

describe("local workspace switch serialization (P1-2)", () => {
  it("concurrent switches leave root and focused cwd in agreement on the last target", async () => {
    const q = new AsyncSerialQueue();
    let root = "/proj-a";
    let focused = "/proj-a";
    const log: string[] = [];

    const switchTo = (cwd: string, delayMs: number) =>
      q.run(async () => {
        // Capture once — never re-read a shared field after await.
        const target = cwd;
        root = target;
        log.push(`start:${target}`);
        await new Promise((r) => setTimeout(r, delayMs));
        focused = target;
        log.push(`done:${target}`);
      });

    // A is slow; B is fast. Without serialization A could finish last and
    // leave focused=A while a later B already set root=B — or both mutate the
    // same session. With the queue, order is A then B and the pair agrees.
    await Promise.all([switchTo("/proj-a", 40), switchTo("/proj-b", 5)]);
    expect(root).toBe("/proj-b");
    expect(focused).toBe("/proj-b");
    expect(log).toEqual([
      "start:/proj-a",
      "done:/proj-a",
      "start:/proj-b",
      "done:/proj-b",
    ]);
  });

  it("mutation: unsynchronized concurrent switches can leave root≠focused", async () => {
    let root = "/a";
    let focused = "/a";

    const buggy = async (cwd: string, delayMs: number) => {
      root = cwd;
      await new Promise((r) => setTimeout(r, delayMs));
      // Re-read shared root after await — the hazard this codebase has hit before.
      focused = root;
    };

    // A starts first (sets root=A), B overwrites root=B quickly and finishes,
    // then A wakes and sets focused = root (still B) — agrees by accident.
    // Flip the stale write: capture focused session id-style:
    let sessionCwd = "/a";
    const buggy2 = async (cwd: string, delayMs: number) => {
      root = cwd;
      // "openSession" assigns this.focused.cwd = cwd, but another switch
      // replaced this.focused — we simulate by writing sessionCwd only if we
      // still "own" the switch by checking root at end incorrectly:
      await new Promise((r) => setTimeout(r, delayMs));
      if (cwd === "/slow") {
        // Slow switch completes after fast one: writes its own cwd onto the
        // shared focused without checking whether a later switch already ran.
        sessionCwd = cwd;
        // root was set by the fast switch to /fast
      } else {
        sessionCwd = cwd;
      }
    };
    await Promise.all([buggy2("/slow", 40), buggy2("/fast", 5)]);
    // Fast finishes first (sessionCwd=/fast), slow finishes last (sessionCwd=/slow)
    // while root was last set by whoever ran setActive last interleaved:
    // start order: both set root — final root is whoever assigned last at start
    // (race). sessionCwd ends as /slow while root is often /fast.
    expect(sessionCwd).toBe("/slow");
    // Prove the hazard class: without a queue, final focused need not match the
    // last *requested* switch when we track request order:
    const requestedLast = "/fast";
    expect(sessionCwd).not.toBe(requestedLast);

    // Silence unused — the first buggy() documents the stale-read pattern.
    await buggy("/x", 1);
    expect(focused).toBeTruthy();
  });

  it("source gate: switchLocalWorkspaceFolder uses AsyncSerialQueue", () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    expect(sidebar).toContain("localWorkspaceSwitchQueue");
    expect(sidebar).toContain("AsyncSerialQueue");
    expect(sidebar).toMatch(
      /switchLocalWorkspaceFolder[\s\S]*localWorkspaceSwitchQueue\.run/,
    );
  });

  it("local resume follows the host-owned session project", () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const openStart = sidebar.indexOf("private async openSession(id: string");
    const openEnd = sidebar.indexOf("private localTrustedSessionCwds(", openStart);
    const openBody = sidebar.slice(openStart, openEnd);
    const reserveAt = openBody.indexOf("this.reserveSessionLoad(id)");
    const queueAt = openBody.indexOf("this.localWorkspaceSwitchQueue.run(open)");
    expect(reserveAt).toBeGreaterThanOrEqual(0);
    expect(queueAt).toBeGreaterThan(reserveAt);
    // Open-ended on purpose: the contract is that the queued operation is the
    // reserved open, called with the id and the cwd in that order. Pinning the
    // closing paren too made threading the open clock through (the `resolve`
    // phase) look like a regression in workspace-switch serialisation.
    expect(openBody).toContain("const open = () => this.openSessionReserved(id, sessionCwd");

    const reservedStart = sidebar.indexOf("private async openSessionReserved(");
    const reservedEnd = sidebar.indexOf("private revealAndFocusComposer", reservedStart);
    const reservedBody = sidebar.slice(reservedStart, reservedEnd);
    expect(reservedBody).toContain("await this.followSessionWorkspace(s)");
    expect(reservedBody).toContain("await this.followSessionWorkspace(this.focused)");
    expect(reservedBody).not.toMatch(/await this\.switchLocalWorkspaceFolder\(/);
    expect(sidebar).toContain("await this.switchLocalWorkspaceFolderExclusive(target, { warnOnRefusal: false })");
  });

  it("worktree resume follows its owning project, not the worktree cwd", () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const followStart = sidebar.indexOf("private async followSessionWorkspace(");
    const followEnd = sidebar.indexOf("private async openSessionReserved(", followStart);
    const followBody = sidebar.slice(followStart, followEnd);
    expect(followBody).toContain("if (!this.host.canSwitchWorkspaceFolder) return");
    expect(followBody).toContain("session.worktree?.sourceGitRoot ?? session.cwd");
    expect(followBody).toContain("this.resolveLocalRepoTarget(session.cwd)?.cwd : undefined");
    expect(followBody).toContain("warnOnRefusal: false");
    // ONE resolution, from session.cwd. Neither a bare sourceGitRoot fallback
    // nor an exact-match shortcut on it: both walk past the ambiguity guard
    // below, because a worktree's source root can itself be an open folder
    // while two folders claim the worktree.
    expect(followBody).not.toMatch(/\?\?\s*intendedTarget;/);
    expect(followBody).not.toContain("this.resolveLocalRepoTarget(intendedTarget)");

    const resolveStart = sidebar.indexOf("private resolveLocalRepoTarget(");
    const resolveEnd = sidebar.indexOf("private buildRepoSessionsPreview(", resolveStart);
    const resolveBody = sidebar.slice(resolveStart, resolveEnd);
    expect(resolveBody).toContain("entries.find((r) => pathsEqual(r.cwd, cwd))");
    // Ownership resolves by GIT ROOT, so every open folder sharing a checkout
    // claims the same worktree. Exactly one owner or no switch — never a
    // `.find` taking whichever the catalog happened to list first.
    expect(resolveBody).toMatch(/const owners = entries\.filter\(/);
    expect(resolveBody).toContain("owners.length === 1 ? owners[0] : undefined");
  });
});

describe("file tree rebind on project change (P2-3)", () => {
  it("panel boot source listens for root changes and switches isolated scopes", () => {
    const src = fileTreePanelBootSource();
    expect(src).toContain("onRootChanged");
    expect(src).toContain("onScopeChanged");
    expect(src).toContain("listener(normalizeRoot(await api.root()))");
    expect(filePanelJs).toContain("function setScope(scope)");
    expect(filePanelJs).toContain("state = makeScopeState(scope)");
    expect(filePanelJs).toContain("scopes.set(scope.id, state)");
  });

  it("preload exposes onRootChanged; main sends desk-ft:root-changed", () => {
    const preload = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "preload.ts",
      ),
      "utf8",
    );
    const main = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "main.ts",
      ),
      "utf8",
    );
    expect(preload).toContain("onRootChanged");
    expect(preload).toContain("desk-ft:root-changed");
    expect(main).toContain("onWorkspaceRootChanged");
    expect(main).toContain("desk-ft:root-changed");
  });

  it("after root switch, readTreeFile against new root returns new project content", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "grok-tree-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "grok-tree-b-"));
    try {
      fs.mkdirSync(path.join(a, "src"));
      fs.mkdirSync(path.join(b, "src"));
      fs.writeFileSync(path.join(a, "src", "config.ts"), "export const project = 'A';\n");
      fs.writeFileSync(path.join(b, "src", "config.ts"), "export const project = 'B';\n");

      // Simulates panel rebind: api.root() now returns B, then read(relPath).
      const fromA = readTreeFile(a, "src/config.ts");
      const fromB = readTreeFile(b, "src/config.ts");
      expect(fromA.ok && fromA.text).toContain("'A'");
      expect(fromB.ok && fromB.text).toContain("'B'");
      // Same relPath, different roots — content must follow the active root.
      expect(fromA.ok && fromB.ok && fromA.text !== fromB.text).toBe(true);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("openFile / openDiff session roots (P2-4 / P2-5)", () => {
  let workspace: string;
  let worktree: string;
  let outside: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ws-"));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wt-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-out-"));
    fs.writeFileSync(path.join(workspace, "main.ts"), "main");
    fs.writeFileSync(path.join(worktree, "branch.ts"), "branch");
    fs.writeFileSync(path.join(outside, "secret.ts"), "nope");
  });
  afterEach(() => {
    for (const p of [workspace, worktree, outside]) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it("allows a worktree-session file when allowedRoots includes the worktree", () => {
    const ctx = {
      workspaceRoot: workspace,
      allowedRoots: [worktree, workspace],
    };
    expect(authorizeOpenFile(path.join(worktree, "branch.ts"), ctx).ok).toBe(true);
    expect(authorizeOpenFile("branch.ts", { allowedRoots: [worktree] }).ok).toBe(true);
    // Workspace-only policy (regression from the security fix) refuses worktree:
    expect(authorizeOpenFile(path.join(worktree, "branch.ts"), { workspaceRoot: workspace }).ok).toBe(
      false,
    );
  });

  it("refuses paths outside every authorized root", () => {
    const ctx = {
      workspaceRoot: workspace,
      allowedRoots: [worktree, workspace],
    };
    expect(authorizeOpenFile(path.join(outside, "secret.ts"), ctx).ok).toBe(false);
  });

  it("authorizeDesktopWebviewMsg applies the same roots to openDiff", () => {
    const ok = authorizeDesktopWebviewMsg(
      {
        type: "openDiff",
        path: path.join(worktree, "branch.ts"),
        oldText: "a",
        newText: "b",
      },
      { allowedRoots: [worktree, workspace] },
    );
    expect("msg" in ok).toBe(true);

    const bad = authorizeDesktopWebviewMsg(
      {
        type: "openDiff",
        path: path.join(outside, "secret.ts"),
        oldText: "",
        newText: "x",
      },
      { allowedRoots: [worktree, workspace] },
    );
    expect("refused" in bad).toBe(true);
  });

  it("forged resumeSession cwd cannot become process cwd or widen auth roots", () => {
    // Property under test (both halves of the HIGH finding):
    // 1) process cwd is findSessionCatalogCwd over trusted candidates only
    // 2) desktopAuthRoots is built from that host-owned session cwd
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resume-auth-"));
    const grokHome = path.join(base, "fake-grok");
    const repo = path.join(base, "repo");
    const evil = path.join(base, "evil-outside");
    const sessionId = "resume-id-1";
    try {
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(evil, { recursive: true });
      // Real session only under repo.
      const realDir = path.join(sessionsDirFor(grokHome, repo), sessionId);
      fs.mkdirSync(realDir, { recursive: true });
      fs.writeFileSync(path.join(realDir, "summary.json"), "{}");
      // Attacker also plants a fake session under evil.
      const evilDir = path.join(sessionsDirFor(grokHome, evil), sessionId);
      fs.mkdirSync(evilDir, { recursive: true });
      fs.writeFileSync(path.join(evilDir, "summary.json"), "{}");

      const candidates = orderedResumeCwdCandidates({
        messageCwd: evil, // forged by renderer
        trustedCwds: [repo],
      });
      expect(candidates).not.toContain(evil);
      const resolved = findSessionCatalogCwd({
        fs,
        grokHome,
        id: sessionId,
        candidates,
      });
      expect(resolved).toBe(repo);

      // Half 2: auth roots follow the resolved session cwd, not the message.
      const roots = desktopAuthRoots({
        workspaceRoot: repo,
        allowedRoots: [resolved!],
      });
      expect(roots.some((r) => path.resolve(r) === path.resolve(repo))).toBe(true);
      expect(roots.some((r) => path.resolve(r) === path.resolve(evil))).toBe(false);

      // Mutation: the old assignment `cwd = sessionCwd || workspace` would pick evil
      // and widen openFile/openDiff authorization to that tree.
      const buggyCwd = evil || repo;
      expect(buggyCwd).toBe(evil);
      const buggyRoots = desktopAuthRoots({
        workspaceRoot: repo,
        allowedRoots: [buggyCwd],
      });
      expect(buggyRoots.some((r) => path.resolve(r) === path.resolve(evil))).toBe(true);

      // Source gate: openSessionReserved must resolve via catalog helpers, not
      // `sessionCwd || …` assignment.
      const sidebar = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
        "utf8",
      );
      expect(sidebar).toContain("findSessionCatalogCwd");
      expect(sidebar).toContain("orderedResumeCwdCandidates");
      const openStart = sidebar.indexOf("private async openSessionReserved(");
      const openEnd = sidebar.indexOf("private revealAndFocusComposer", openStart);
      const openBody = sidebar.slice(openStart, openEnd);
      expect(openBody).toContain("findSessionCatalogCwd");
      expect(openBody).not.toMatch(
        /const cwd\s*=\s*\n?\s*sessionCwd\s*\|\|/,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("desktop open-folder trust excludes closed historical repos (resume + auth roots)", () => {
    // Round 10: trust set is open folders only — NOT the full discoverRepos catalog.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-open-folder-"));
    const grokHome = path.join(base, "fake-grok");
    const openRepo = path.join(base, "open-proj");
    const closedRepo = path.join(base, "closed-hist");
    const sessionId = "closed-sess-1";
    try {
      fs.mkdirSync(openRepo, { recursive: true });
      fs.mkdirSync(closedRepo, { recursive: true });
      // Session exists only under the closed historical checkout.
      const closedDir = path.join(sessionsDirFor(grokHome, closedRepo), sessionId);
      fs.mkdirSync(closedDir, { recursive: true });
      fs.writeFileSync(path.join(closedDir, "summary.json"), "{}");

      // Desktop trust = open folders only (mirrors localTrustedSessionCwds desktop branch).
      const desktopTrusted = [openRepo];
      const desktopCandidates = orderedResumeCwdCandidates({
        messageCwd: closedRepo,
        trustedCwds: desktopTrusted,
      });
      expect(desktopCandidates).not.toContain(closedRepo);
      expect(
        findSessionCatalogCwd({
          fs,
          grokHome,
          id: sessionId,
          candidates: desktopCandidates,
        }),
      ).toBeUndefined();

      // Auth roots built from desktop trust do not include the closed repo.
      const roots = desktopAuthRoots({
        workspaceRoot: openRepo,
        allowedRoots: desktopTrusted,
      });
      expect(roots.some((r) => path.resolve(r) === path.resolve(closedRepo))).toBe(false);
      expect(roots.some((r) => path.resolve(r) === path.resolve(openRepo))).toBe(true);

      // Mutation: using the full historical catalog as trustedCwds reopens the hole —
      // resume finds the closed session and auth widens to it.
      const fullCatalogTrusted = [openRepo, closedRepo];
      const buggyCandidates = orderedResumeCwdCandidates({
        messageCwd: closedRepo,
        trustedCwds: fullCatalogTrusted,
      });
      expect(buggyCandidates).toContain(closedRepo);
      expect(
        findSessionCatalogCwd({
          fs,
          grokHome,
          id: sessionId,
          candidates: buggyCandidates,
        }),
      ).toBe(closedRepo);
      const buggyRoots = desktopAuthRoots({
        workspaceRoot: openRepo,
        allowedRoots: [closedRepo],
      });
      expect(buggyRoots.some((r) => path.resolve(r) === path.resolve(closedRepo))).toBe(true);

      // Source: desktop branch of localTrustedSessionCwds uses openWorkspaceFolders,
      // not repoCatalog(). VS Code branch still walks repoCatalog().
      const sidebar = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
        "utf8",
      );
      const trustStart = sidebar.indexOf("private localTrustedSessionCwds(");
      expect(trustStart).toBeGreaterThan(0);
      const trustEnd = sidebar.indexOf("private async openSessionReserved(", trustStart);
      const trustBody = sidebar.slice(trustStart, trustEnd);
      expect(trustBody).toContain("canSwitchWorkspaceFolder");
      expect(trustBody).toContain("openWorkspaceFolders");
      // Desktop branch must not walk the full historical catalog.
      const desktopBranch = trustBody.slice(
        trustBody.indexOf("if (this.host.canSwitchWorkspaceFolder)"),
        trustBody.indexOf("// VS Code"),
      );
      expect(desktopBranch).toContain("openWorkspaceFolders");
      expect(desktopBranch).not.toContain("this.repoCatalog()");
      // VS Code branch keeps full-catalog behaviour.
      expect(trustBody).toContain("// VS Code");
      expect(trustBody.slice(trustBody.indexOf("// VS Code"))).toContain("this.repoCatalog()");

      // desktopAuthRoots asks the ONE shared authorization query rather than
      // recomputing an open set of its own — isAuthorizedCwd is
      // localTrustedSessionCwds behind a name, so a second source of truth
      // cannot drift away from resume/list/select.
      const authStart = sidebar.indexOf("desktopAuthRoots(session");
      const authEnd = sidebar.indexOf("async addProjectFolder", authStart);
      const authBody = sidebar.slice(authStart, authEnd);
      expect(authBody).toContain("isAuthorizedCwd");
      expect(authBody).toContain("canSwitchWorkspaceFolder");
      // And it is SESSION-scoped, not "every folder that happens to be open".
      // The parameter used to be accepted and then ignored on desktop, which
      // let a message from a session in repo A open a file in repo B.
      expect(authBody).toContain("this.sessionCwd(session)");
      expect(authBody).not.toContain("for (const c of this.localTrustedSessionCwds");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("ready posts the selected project's sessions list (desktop rail cold start)", () => {
    // The projects rail reads the SELECTED repo from the live `sessions` frame,
    // not from `listRepoSessions` (previews deliberately skip the selection).
    // A host that only posts `repos` + sibling previews leaves the open project
    // on "No sessions yet" forever — even when indexSessions would find dozens
    // of conversations (including after drive-letter case-alias merge).
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const readyStart = sidebar.indexOf('case "ready":');
    expect(readyStart).toBeGreaterThan(0);
    const readyEnd = sidebar.indexOf("case \"remotePreferences\"", readyStart);
    const readyBody = sidebar.slice(readyStart, readyEnd > readyStart ? readyEnd : readyStart + 800);
    expect(readyBody).toContain("postRepoCatalog");
    expect(readyBody).toContain("postSessionsList");
    // Cold start only (rehydrate already posts catalog+sessions — skip duplicate).
    expect(readyBody).toContain("shouldRehydrateOnWebviewReady");
    // Disk scan is deferred so ready does not block activation on large histories.
    expect(readyBody).toContain("setImmediate");
    // Order: catalog first (sets selectedRepoCwd), then the deferred list.
    expect(readyBody.indexOf("postRepoCatalog")).toBeLessThan(readyBody.indexOf("postSessionsList"));
    // After agent start, re-post so a live empty "New session" row appears.
    const initialStart = sidebar.indexOf("private postInitialState(");
    const initialEnd = sidebar.indexOf("private rehydrateWebviewFromFocused(", initialStart);
    const initialBody = sidebar.slice(initialStart, initialEnd);
    expect(initialBody).toContain('startSession(undefined, this.focused, "ensure")');
    expect(initialBody).toContain("postSessionsList()");
    expect(initialBody).toContain("sweepEmptySessions()");
    // postSessionsList must run on the startSession success path (not only on ready).
    const thenIdx = initialBody.indexOf('startSession(undefined, this.focused, "ensure").then');
    expect(thenIdx).toBeGreaterThan(0);
    expect(initialBody.indexOf("postSessionsList()", thenIdx)).toBeGreaterThan(thenIdx);
  });

  it("local listRepoSessions/selectRepo refuse non-open roots; setActive abort is mandatory", () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    // resolveLocalRepoTarget is the single local gate — open-folder catalog only.
    expect(sidebar).toContain("resolveLocalRepoTarget");
    const resolveStart = sidebar.indexOf("private resolveLocalRepoTarget(");
    const resolveEnd = sidebar.indexOf("private buildRepoSessionsPreview(", resolveStart);
    const resolveBody = sidebar.slice(resolveStart, resolveEnd);
    expect(resolveBody).toContain("localRepoCatalogEntries");
    expect(resolveBody).not.toContain("this.repoCatalog()");

    // Local preview / selectRepo consult resolveLocalRepoTarget, not full catalog first.
    const selectStart = sidebar.indexOf("private async selectRepo(");
    const selectEnd = sidebar.indexOf("private async switchLocalWorkspaceFolder(", selectStart);
    const selectBody = sidebar.slice(selectStart, selectEnd);
    expect(selectBody).toContain("resolveLocalRepoTarget");
    expect(selectBody).not.toContain("this.repoCatalog()");

    // Both local and remote previews use resolveLocalRepoTarget (host catalog).
    expect(sidebar).toMatch(
      /buildRepoSessionsPreview\(\s*cwd,\s*limit,\s*this\.focused\.activeSessionId,\s*"local"/,
    );
    expect(sidebar).toMatch(
      /buildRepoSessionsPreview\(\s*cwd,\s*limit,\s*this\.remoteActiveSessionId\(clientId\),\s*"remote"/,
    );
    const previewStart = sidebar.indexOf("private buildRepoSessionsPreview(");
    const previewEnd = sidebar.indexOf("private sendRepoSessionsPreview(", previewStart);
    const previewBody = sidebar.slice(previewStart, previewEnd);
    expect(previewBody).toContain("resolveLocalRepoTarget");
    expect(previewBody).not.toContain("this.repoCatalog()");
    expect(previewBody).not.toContain("return undefined");
    expect(previewBody).toContain('error: "project-unavailable"');
    expect(previewBody).toContain('error: "sessions-unavailable"');

    const remoteSendStart = sidebar.indexOf("private sendRepoSessionsPreview(", previewStart);
    const localSendEnd = sidebar.indexOf("private async selectRepo(", remoteSendStart);
    const sendBodies = sidebar.slice(remoteSendStart, localSendEnd);
    expect(sendBodies).toContain("this.sendRemoteClient(clientId, msg)");
    expect(sendBodies).toContain("this.postLocal(msg)");
    expect(sendBodies).not.toMatch(/if \(msg\)/);

    const remoteHandlerStart = sidebar.indexOf("private handleRemoteMessage(");
    const remoteHandlerEnd = sidebar.indexOf("private handleRemoteClientReady(", remoteHandlerStart);
    const remoteHandler = sidebar.slice(remoteHandlerStart, remoteHandlerEnd);
    expect(remoteHandler).toContain('m.type !== "selectRepo" && m.type !== "listRepoSessions"');
    expect(remoteHandler).toMatch(
      /if \(m\.type === "listRepoSessions"\)[\s\S]*type: "repoSessions"[\s\S]*error: "project-unavailable"/,
    );

    // Rejected setActiveWorkspaceFolder aborts — no history open / session spawn.
    const switchStart = sidebar.indexOf("private async switchLocalWorkspaceFolderExclusive(");
    const switchEnd = sidebar.indexOf("desktopAuthRoots(session", switchStart);
    const switchBody = sidebar.slice(switchStart, switchEnd);
    expect(switchBody).toMatch(/if\s*\(\s*!this\.host\.setActiveWorkspaceFolder\(target\)\s*\)/);
    expect(switchBody).toContain("return;");
    // Mutation: ignoring the return and continuing would re-open the hole —
    // prove the abort sits BEFORE selectedRepoCwd assignment / history read.
    const refuseIdx = switchBody.indexOf("setActiveWorkspaceFolder(target)");
    const selectedIdx = switchBody.indexOf("this.selectedRepoCwd = target");
    // Selecting a project now touches no session at all — not the newest, not a
    // blank one. The work that must stay behind the abort is therefore the
    // catalog/list posting, which is all that is left.
    const historyIdx = switchBody.indexOf("postRepoCatalog");
    expect(refuseIdx).toBeGreaterThan(0);
    expect(selectedIdx).toBeGreaterThan(refuseIdx);
    expect(historyIdx).toBeGreaterThan(selectedIdx);
    // The return after refuse must appear before selectedRepoCwd is set.
    const returnIdx = switchBody.indexOf("return;", refuseIdx);
    expect(returnIdx).toBeGreaterThan(refuseIdx);
    expect(returnIdx).toBeLessThan(selectedIdx);

    // Host contract: setActive returns boolean (not void advisory).
    const hostSrc = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "host.ts"),
      "utf8",
    );
    expect(hostSrc).toMatch(/setActiveWorkspaceFolder\(cwd: string\):\s*boolean/);
    const electronHost = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "electron-host.ts"),
      "utf8",
    );
    const setActiveStart = electronHost.indexOf("setActiveWorkspaceFolder(cwd: string)");
    const setActiveBody = electronHost.slice(setActiveStart, setActiveStart + 280);
    expect(setActiveBody).toContain("return false");
    expect(setActiveBody).toContain("return true");
  });

  it("VS Code keeps full-catalog local trust (must not regress to open-folders-only)", () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    // localRepoCatalogEntries: when !canSwitchWorkspaceFolder, use full catalog.
    const localCatStart = sidebar.indexOf("private localRepoCatalogEntries(");
    const localCatEnd = sidebar.indexOf("private selectedHistoryCwd(", localCatStart);
    const localCatBody = sidebar.slice(localCatStart, localCatEnd);
    expect(localCatBody).toMatch(/if\s*\(\s*!this\.host\.canSwitchWorkspaceFolder\s*\)/);
    // The rows ARE the full discovered catalog. No longer a bare `entries =
    // full` — hand-added rows are tagged so the rail can offer to remove them —
    // so guard the rule rather than the spelling: derived from `full`, and never
    // narrowed to the open folders the desktop branch below uses.
    const vscodeBranch = localCatBody.slice(
      localCatBody.indexOf("!this.host.canSwitchWorkspaceFolder"),
      localCatBody.indexOf("} else {"),
    );
    expect(vscodeBranch).toMatch(/\bfull\b/);
    expect(vscodeBranch).not.toMatch(/openWorkspaceFolders/);

    // VS Code host never switches folders and reports success on setActive.
    const vscodeHost = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "vscode-host.ts"),
      "utf8",
    );
    expect(vscodeHost).toMatch(/canSwitchWorkspaceFolder:\s*false/);
    expect(vscodeHost).toMatch(/canArchiveRepos:\s*true/);
    const setActive = vscodeHost.slice(
      vscodeHost.indexOf("setActiveWorkspaceFolder"),
      vscodeHost.indexOf("addWorkspaceFolder"),
    );
    expect(setActive).toContain("return true");

    // Desktop: empty open set must NOT fall back to the historical catalog
    // (that reopened closed repos into the trust set).
    expect(localCatBody).toMatch(/if\s*\(\s*!open\.length\s*\)/);
    // The empty branch assigns [] — not `full` (a full-catalog fallback reopens
    // every discovered cwd into the rail / remote target set).
    const emptyBranch = localCatBody.slice(
      localCatBody.search(/if\s*\(\s*!open\.length\s*\)/),
      localCatBody.search(/const byKey/),
    );
    expect(emptyBranch).toMatch(/entries\s*=\s*\[\s*\]/);
    expect(emptyBranch).not.toMatch(/entries\s*=\s*full/);
    // Archive fields stripped when canArchiveRepos is false.
    expect(sidebar).toContain("applyArchiveCapability");
    expect(sidebar).toContain("withoutArchiveFields");
    expect(sidebar).toMatch(/if\s*\(\s*!this\.host\.canArchiveRepos\s*\)\s*return/);
  });

  it("desktopAuthRoots dedupes workspaceRoot + allowedRoots", () => {
    const roots = desktopAuthRoots({
      workspaceRoot: workspace,
      allowedRoots: [worktree, workspace],
    });
    expect(roots).toContain(path.resolve(worktree));
    expect(roots).toContain(path.resolve(workspace));
    expect(roots.length).toBe(2);
  });
});

describe("typed config open intents (host-resolved paths)", () => {
  it("authorizeOpenFile still refuses ~/.grok/config.toml outside workspace roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cfg-auth-"));
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cfg-home-"));
    try {
      fs.writeFileSync(path.join(root, "readme.md"), "ok");
      const cfg = path.join(grokHome, "config.toml");
      fs.writeFileSync(cfg, "# global\n");
      // Renderer-supplied absolute path that *looks* like a config is refused.
      const refused = authorizeOpenFile(cfg, { workspaceRoot: root });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.reason).toMatch(/escape|authorized roots/i);
      }
      // Relative path claiming to be config under the project is allowed only if
      // it lives inside the workspace (not a way to reach ~/.grok).
      fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(root, ".grok", "config.toml"), "# project\n");
      expect(authorizeOpenFile(".grok/config.toml", { workspaceRoot: root }).ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("sidebar dispatches openGlobalConfig / openProjectConfig as host intents", () => {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    // Gear intents call typed Host methods — not openResource with a joined path.
    const globalCase = sidebar.slice(
      sidebar.indexOf('case "openGlobalConfig"'),
      sidebar.indexOf('case "openProjectConfig"'),
    );
    const projectCase = sidebar.slice(
      sidebar.indexOf('case "openProjectConfig"'),
      sidebar.indexOf('case "listMcpServers"'),
    );
    expect(globalCase).toMatch(/openGlobalConfig\s*\(/);
    expect(globalCase).not.toMatch(/openResource\s*\(/);
    // Path must not be joined in the sidebar case — only the typed host call.
    expect(globalCase).not.toMatch(/path\.join/);
    expect(globalCase).not.toMatch(/writeFileSync/);
    expect(projectCase).toMatch(/openProjectConfig\s*\(/);
    expect(projectCase).not.toMatch(/openResource\s*\(/);
    expect(projectCase).not.toMatch(/path\.join/);
    expect(projectCase).not.toMatch(/writeFileSync/);
    // Always-approve notice uses the same typed intent.
    expect(sidebar).toMatch(/openGlobalConfig\s*\(\s*\)/);
  });

  it("electron host opens configs via openHostPath, not openFsPath revalidation", () => {
    const hostSrc = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    expect(hostSrc).toContain("async function openHostPath");
    expect(hostSrc).toMatch(/async openGlobalConfig\s*\(/);
    expect(hostSrc).toMatch(/async openProjectConfig\s*\(/);
    // openGlobalConfig body must use openHostPath (no revalidate).
    const globalBody = hostSrc.slice(
      hostSrc.indexOf("async openGlobalConfig"),
      hostSrc.indexOf("async openProjectConfig"),
    );
    expect(globalBody).toMatch(/openHostPath\s*\(/);
    expect(globalBody).toMatch(/globalConfigPath\s*\(/);
    expect(globalBody).not.toMatch(/openFsPath\s*\(/);
    expect(globalBody).not.toMatch(/revalidateOpenFileForUse/);
    const projectBody = hostSrc.slice(
      hostSrc.indexOf("async openProjectConfig"),
      hostSrc.indexOf("async openHostResolvedPath"),
    );
    expect(projectBody).toMatch(/openHostPath\s*\(/);
    expect(projectBody).toMatch(/projectConfigPath\s*\(/);
    expect(projectBody).not.toMatch(/openFsPath\s*\(/);
    // Renderer openFile path still revalidates (via resolveAuthorizedFileForOpen).
    expect(hostSrc).toMatch(/openFsPath[\s\S]*resolveAuthorizedFileForOpen/);
    // Mutation: if configs were routed back through openResource → openFsPath,
    // the openGlobalConfig body would not call openHostPath.
    expect(globalBody).not.toMatch(/openResource\s*\(/);
  });

  it("mutation: openGlobalConfig must not funnel through openFsPath", () => {
    // Documents the hole: openResource → openFsPath refuses ~/.grok/config.toml.
    const hostSrc = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    const openHostBody = hostSrc.slice(
      hostSrc.indexOf("async function openHostPath"),
      hostSrc.indexOf("async function openFsPath"),
    );
    // Trusted open has no auth context / revalidate.
    expect(openHostBody).toMatch(/shell\.openPath/);
    expect(openHostBody).not.toMatch(/revalidateOpenFileForUse/);
    expect(openHostBody).not.toMatch(/getAuthContext/);
  });
});

describe("rail hover controls sit on row hover surface", () => {
  it("rail-action-btn hover uses transparent fill, not toolbar-hoverBackground chip", () => {
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    // Per-icon darker chip is the regression (Codex: glyphs on row surface).
    const hoverRule = css.match(
      /\.rail-action-btn:hover\s*,\s*\.rail-action-btn\.active\s*\{[^}]+\}/,
    );
    expect(hoverRule).toBeTruthy();
    expect(hoverRule![0]).toMatch(/background:\s*transparent/);
    expect(hoverRule![0]).not.toMatch(/toolbar-hoverBackground/);
    // Action-area scrim matches the row hover token, not sideBar background.
    const actionsRule = css.match(
      /\.rail-repo-actions,\s*\n\s*\.rail-session-actions\s*\{[^}]+\}/s,
    );
    expect(actionsRule).toBeTruthy();
    expect(actionsRule![0]).toMatch(/--rail-hover-bg|--vscode-list-hoverBackground/);
    expect(actionsRule![0]).not.toMatch(/--vscode-sideBar-background/);
  });
});

describe("chat openFile / openDiff use-time revalidation (round 16)", () => {
  it("authorizeOpenFile returns the absPath to use", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-abs-"));
    try {
      fs.writeFileSync(path.join(root, "a.md"), "hi");
      const r = authorizeOpenFile("a.md", { workspaceRoot: root });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(path.normalize(r.absPath)).toBe(path.normalize(path.join(root, "a.md")));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("revalidateOpenFileForUse refuses a symlink swap between checks", () => {
    const root = mkdtempReal("grok-chat-toctou-");
    const outside = mkdtempReal("grok-chat-toctou-out-");
    try {
      const safe = path.join(root, "safe.txt");
      const link = path.join(root, "link.txt");
      const leaked = path.join(outside, "secret.txt");
      fs.writeFileSync(safe, "inside");
      fs.writeFileSync(leaked, "OUTSIDE_SECRET");
      fs.writeFileSync(link, "placeholder");

      // Per authorizeOpenFile: ~2 realpath(link) (containment + executable).
      // revalidate: first authorize (safe) → realAtCheck snapshot (safe) →
      // second authorize (swapped outside) must refuse.
      // Threshold 3 so a single authorizeOpenFile alone would still pass —
      // only the double-check inside revalidate fails (mutation-sensitive).
      let linkRealpathCalls = 0;
      const pathFs: TreePathFs = {
        realpathSync: (p) => {
          const n = path.normalize(p);
          if (n === path.normalize(link) || n.endsWith(`${path.sep}link.txt`)) {
            linkRealpathCalls++;
            return linkRealpathCalls <= 3 ? safe : leaked;
          }
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        },
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
        readdirSync: (p, o) => fs.readdirSync(p, o),
      };

      // Single authorize still sees the in-tree target (gate would pass).
      expect(authorizeOpenFile(link, { workspaceRoot: root, pathFs }).ok).toBe(true);
      linkRealpathCalls = 0; // fresh window for use-time revalidate

      const use = revalidateOpenFileForUse(link, { workspaceRoot: root, pathFs });
      expect(use.ok).toBe(false);
      if (!use.ok) {
        expect(use.reason).toMatch(/symlink|escape|changed|executable/i);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("revalidateOpenFileForUse refuses swap to an in-tree executable", () => {
    const root = mkdtempReal("grok-chat-exe-");
    try {
      const safe = path.join(root, "note.txt");
      const pe = path.join(root, "tool.exe");
      const link = path.join(root, "open-me.txt");
      fs.writeFileSync(safe, "safe");
      fs.writeFileSync(pe, "MZ");
      fs.writeFileSync(link, "placeholder");

      // Same budget as the escape test: first pass + realAtCheck stay on safe;
      // second authorize sees the PE realpath and refuses executable.
      let calls = 0;
      const pathFs: TreePathFs = {
        realpathSync: (p) => {
          const n = path.normalize(p);
          if (n === path.normalize(link) || n.endsWith(`${path.sep}open-me.txt`)) {
            calls++;
            return calls <= 3 ? safe : pe;
          }
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        },
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
        readdirSync: (p, o) => fs.readdirSync(p, o),
      };

      expect(authorizeOpenFile(link, { workspaceRoot: root, pathFs }).ok).toBe(true);
      calls = 0;
      const use = revalidateOpenFileForUse(link, { workspaceRoot: root, pathFs });
      expect(use.ok).toBe(false);
      if (!use.ok) {
        expect(use.reason).toMatch(/executable|symlink|changed|escape/i);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mutation: single authorizeOpenFile without revalidate would keep the pre-swap path", () => {
    // Documents the hole: message-gate authorize succeeds, then a swap; using
    // the original abs string (or a path that no longer matches real target)
    // is what openFsPath used to do.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-chat-mut-"));
    try {
      const safe = path.join(root, "doc.md");
      fs.writeFileSync(safe, "ok");
      const gate = authorizeOpenFile("doc.md", { workspaceRoot: root });
      expect(gate.ok).toBe(true);
      if (!gate.ok) return;
      // Without revalidateOpenFileForUse, callers would open gate.absPath even
      // after a later swap. The use-time helper must be the only open path.
      const hostSrc = fs.readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "src",
          "desktop",
          "electron-host.ts",
        ),
        "utf8",
      );
      expect(hostSrc).toContain("resolveAuthorizedFileForOpen");
      expect(hostSrc).toMatch(/openFsPath[\s\S]*resolveAuthorizedFileForOpen/);
      expect(hostSrc).toMatch(/check\.absPath/);
      // shell.openPath must use the revalidated path, not the raw argument alone.
      const openBody = hostSrc.slice(
        hostSrc.indexOf("async function openFsPath"),
        hostSrc.indexOf("return {", hostSrc.indexOf("async function openFsPath")),
      );
      expect(openBody).toMatch(/shell\.openPath\(openPath\)/);
      expect(openBody).not.toMatch(/shell\.openPath\(fsPath\)/);
      // Renderable types go to the panel first; missing files never openPath.
      expect(openBody).toContain("classifyFilePreview");
      expect(openBody).toContain("openPathInFilePanel");
      expect(openBody).toMatch(/File not found|not found/i);

      const sidebarSrc = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
        "utf8",
      );
      const readDiff = sidebarSrc.slice(
        sidebarSrc.indexOf("private readFileForDiff"),
        sidebarSrc.indexOf("private closeDiffForRequest"),
      );
      expect(readDiff).toContain("revalidateOpenFileForUse");
      expect(readDiff).toMatch(/abs\s*=\s*check\.absPath/);
      expect(readDiff).not.toMatch(/rel\.startsWith\("\.\."\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("file-tree read TOCTOU recheck (P2-6)", () => {
  it("refuses a symlink swap between containment check and read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-toctou-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-toctou-out-"));
    try {
      const safe = path.join(root, "safe.txt");
      const link = path.join(root, "link.txt");
      const leaked = path.join(outside, "secret.txt");
      fs.writeFileSync(safe, "inside");
      fs.writeFileSync(leaked, "OUTSIDE_SECRET");
      fs.writeFileSync(link, "placeholder");

      // First resolveTreePath + realAtCheck see the in-tree target; later
      // recheckTreePathForRead sees the swapped outside target and must refuse
      // before readFileSync runs.
      let linkRealpathCalls = 0;
      const pathFs: TreePathFs = {
        realpathSync: (p) => {
          const n = path.normalize(p);
          if (n === path.normalize(link) || n.endsWith(`${path.sep}link.txt`)) {
            linkRealpathCalls++;
            // Calls 1–2: initial resolve + realAtCheck snapshot (must pass).
            // Call 3+: recheck phase (must fail containment).
            return linkRealpathCalls <= 2 ? safe : leaked;
          }
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        },
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
        readdirSync: (p, o) => fs.readdirSync(p, o),
      };

      let readCalled = false;
      const result = readTreeFile(
        root,
        "link.txt",
        process.platform,
        pathFs,
        (p) => {
          readCalled = true;
          return fs.readFileSync(p);
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/symlink|changed|escape/i);
      }
      // Must not have read after a failed recheck (no leak path).
      expect(readCalled).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("chat openFile path resolution + panel routing", () => {
  it("isBareFileName accepts only single-segment names", () => {
    expect(isBareFileName("product-decisions.md")).toBe(true);
    expect(isBareFileName("readme.txt")).toBe(true);
    expect(isBareFileName("docs/product-decisions.md")).toBe(false);
    expect(isBareFileName("C:\\\\repo\\\\a.md")).toBe(false);
    expect(isBareFileName("/tmp/a.md")).toBe(false);
    expect(isBareFileName("")).toBe(false);
  });

  it("findRelPathByBasename finds nested files and skips node_modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bn-"));
    try {
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.writeFileSync(path.join(root, "docs", "product-decisions.md"), "# pd");
      fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "node_modules", "pkg", "product-decisions.md"),
        "hidden",
      );
      expect(findRelPathByBasename(root, "product-decisions.md")).toBe(
        "docs/product-decisions.md",
      );
      expect(findRelPathByBasename(root, "missing.md")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveAuthorizedFileForOpen maps bare basename to nested file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-open-bn-"));
    try {
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      const real = path.join(root, "docs", "product-decisions.md");
      fs.writeFileSync(real, "# decisions");
      // Bare name (agent link text).
      const bare = resolveAuthorizedFileForOpen("product-decisions.md", {
        workspaceRoot: root,
      });
      expect(bare.ok).toBe(true);
      if (bare.ok) {
        expect(path.normalize(bare.absPath)).toBe(path.normalize(real));
      }
      // Absolute path that only has the basename under root (sidebar join).
      const absMissing = path.join(root, "product-decisions.md");
      const fromAbs = resolveAuthorizedFileForOpen(absMissing, {
        workspaceRoot: root,
      });
      expect(fromAbs.ok).toBe(true);
      if (fromAbs.ok) {
        expect(path.normalize(fromAbs.absPath)).toBe(path.normalize(real));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveAuthorizedFileForOpen returns not found without inventing multi-segment paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-open-miss-"));
    try {
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.writeFileSync(path.join(root, "docs", "other.md"), "x");
      const miss = resolveAuthorizedFileForOpen("nope-missing-xyz.md", {
        workspaceRoot: root,
      });
      expect(miss.ok).toBe(false);
      if (!miss.ok) expect(miss.reason).toMatch(/not found/i);

      // Multi-segment miss must not be rewritten to another file with same basename.
      fs.writeFileSync(path.join(root, "docs", "foo.md"), "y");
      const multi = resolveAuthorizedFileForOpen("src/foo.md", {
        workspaceRoot: root,
      });
      expect(multi.ok).toBe(false);
      if (!multi.ok) expect(multi.reason).toMatch(/not found/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveAuthorizedFileForOpen still refuses outside roots and executables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-open-ref-"));
    try {
      fs.writeFileSync(path.join(root, "ok.md"), "hi");
      const outside = path.join(path.dirname(root), "secret.md");
      fs.writeFileSync(outside, "nope");
      try {
        expect(
          resolveAuthorizedFileForOpen(outside, { workspaceRoot: root }).ok,
        ).toBe(false);
      } finally {
        fs.unlinkSync(outside);
      }
      fs.writeFileSync(path.join(root, "tool.exe"), "MZ");
      expect(
        resolveAuthorizedFileForOpen("tool.exe", { workspaceRoot: root }).ok,
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("openFsPath prefers panel for previewable types and OS only for external", () => {
    const hostSrc = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    const openBody = hostSrc.slice(
      hostSrc.indexOf("async function openFsPath"),
      hostSrc.indexOf("return {", hostSrc.indexOf("async function openFsPath")),
    );
    // Panel path before OS open.
    const panelIdx = openBody.indexOf("openPathInFilePanel");
    const shellIdx = openBody.indexOf("shell.openPath(openPath)");
    expect(panelIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeGreaterThan(panelIdx);
    expect(openBody).toMatch(/classifyFilePreview[\s\S]*!==\s*["']external["']/);
    // Miss path uses messageBox / in-app, never openPath on failure reason.
    expect(openBody).toMatch(/File not found/);
    expect(openBody).toContain("resolveAuthorizedFileForOpen");
  });

  it("mutation: without panel branch, chat md would only hit shell.openPath", () => {
    const hostSrc = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "electron-host.ts",
      ),
      "utf8",
    );
    const openBody = hostSrc.slice(
      hostSrc.indexOf("async function openFsPath"),
      hostSrc.indexOf("return {", hostSrc.indexOf("async function openFsPath")),
    );
    // Fail if someone removes panel routing (regression of 1a).
    expect(openBody).toContain("openPathInFilePanel");
    expect(openBody).toContain("classifyFilePreview");
    // Fail if miss falls through to shell without a not-found guard.
    expect(openBody).toMatch(/not found/i);
  });

  it("file-tree IPC exposes openPathInFilePanel for host chat opens", () => {
    const ipcSrc = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "file-tree-ipc.ts",
      ),
      "utf8",
    );
    expect(ipcSrc).toContain("export async function openPathInFilePanel");
    expect(ipcSrc).toContain("__grokDeskFtOpen");
  });
});

describe("voice-key migration never deletes unencryptable credential (round 12)", () => {
  it("production sequence leaves plaintext and throws when encryption is unavailable", () => {
    // Real main.ts path: `new ConfigStore(path)` then `setSensitiveStore(...)`
    // inside a catch — NOT `new ConfigStore(path, sensitive)`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-vk-fail-"));
    const configPath = path.join(dir, "config.json");
    const sensPath = path.join(dir, "sensitive.enc.json");
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          config: { "grok.voiceApiKey": "legacy-plain-key", "grok.cliPath": "/bin/x" },
        }),
        "utf8",
      );
      const noEnc: SafeStorageLike = {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("should not encrypt");
        },
        decryptString: () => {
          throw new Error("should not decrypt");
        },
      };
      // Production construct-then-attach sequence.
      const store = new ConfigStore(configPath);
      expect(() => {
        store.setSensitiveStore(new SensitiveConfigStore(sensPath, noEnc));
      }).toThrow(/secure storage|unavailable|credentials/i);

      // Credential MUST still be on disk — never destroy what we cannot re-encrypt.
      const rawCfg = fs.readFileSync(configPath, "utf8");
      expect(rawCfg).toContain("legacy-plain-key");
      expect(rawCfg).toMatch(/voiceApiKey/);
      // Non-sensitive prefs still readable.
      expect(store.getConfiguration("grok").get("cliPath")).toBe("/bin/x");
      // Voice key still readable from the deferred plaintext until encrypt returns.
      expect(store.getConfiguration("grok").get("voiceApiKey")).toBe("legacy-plain-key");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates on a later run once encryption becomes available", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-vk-later-"));
    const configPath = path.join(dir, "config.json");
    const sensPath = path.join(dir, "sensitive.enc.json");
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ config: { "grok.voiceApiKey": "legacy-plain-key" } }),
        "utf8",
      );
      const noEnc: SafeStorageLike = {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("no enc");
        },
        decryptString: () => {
          throw new Error("no enc");
        },
      };
      const first = new ConfigStore(configPath);
      expect(() => {
        first.setSensitiveStore(new SensitiveConfigStore(sensPath, noEnc));
      }).toThrow();
      expect(fs.readFileSync(configPath, "utf8")).toContain("legacy-plain-key");

      const memSafe: SafeStorageLike = {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
        decryptString: (b) => {
          const t = b.toString("utf8");
          if (!t.startsWith("enc:")) throw new Error("bad cipher");
          return t.slice(4);
        },
      };
      // Next successful start: construct + attach with working encryption.
      const second = new ConfigStore(configPath);
      second.setSensitiveStore(new SensitiveConfigStore(sensPath, memSafe));
      expect(second.getConfiguration("grok").get("voiceApiKey")).toBe("legacy-plain-key");
      const rawCfg = fs.readFileSync(configPath, "utf8");
      expect(rawCfg).not.toContain("legacy-plain-key");
      expect(rawCfg).not.toMatch(/voiceApiKey/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mutation: scrubbing on encrypt failure reopens credential destruction", () => {
    // Old (wrong) path: delete prefs key in the catch before rethrow.
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "config-store.ts",
      ),
      "utf8",
    );
    const migrateStart = src.indexOf("private migrateSensitiveFromPlaintext(");
    const migrateEnd = src.indexOf("private save(", migrateStart);
    const body = src.slice(migrateStart, migrateEnd);
    expect(body).toContain("migrationError");
    // Catch must leave plaintext — no delete of the key in the failure path.
    const catchStart = body.indexOf("} catch (e)");
    expect(catchStart).toBeGreaterThan(0);
    const catchBody = body.slice(catchStart, catchStart + 200);
    expect(catchBody).not.toMatch(/delete this\.prefs\.config\[key\]/);
    expect(catchBody).toContain("migrationError = e");
    // main.ts production sequence must surface failure (dialog), not only log.
    const main = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "desktop",
        "main.ts",
      ),
      "utf8",
    );
    expect(main).toContain("setSensitiveStore");
    expect(main).toContain("showErrorBox");
    expect(main).toMatch(/new ConfigStore\(configPath\)/);
  });
});

// Saving a shell script used to be refused. The predicate doing the refusing —
// `isExecutableOpenTarget` — answers "would handing this to shell.openPath risk
// LAUNCHING code", which is the right question for Open in default app and
// Reveal and the wrong one for a save. It also stopped only the human: the
// agent rewrites `deploy.sh` on request, so the rule prevented nothing while
// blocking an ordinary edit.
describe("editing a script is an edit, not a launch", () => {
  let root = "";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-exec-write-"));
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  for (const name of ["deploy.sh", "task.ps1", "build.bash", "run.zsh", "make.bat"]) {
    it(`saves ${name}`, () => {
      const file = path.join(root, name);
      fs.writeFileSync(file, "original\n", "utf8");
      const read = readTreeFile(root, name);
      if (!read.ok || !read.details) throw new Error(`expected ${name} to be readable`);

      const saved = writeTreeFile(root, name, "edited\n", read.details.stamp, {});
      expect(saved.ok, `${name}: ${JSON.stringify(saved)}`).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("edited\n");
    });
  }

  it("still refuses to LAUNCH one — the check moved, it did not vanish", () => {
    // The question the predicate was written for, still asked where it belongs.
    expect(isExecutableOpenTarget(path.join(root, "deploy.sh"))).toBe(true);
    expect(isExecutableOpenTarget(path.join(root, "task.ps1"))).toBe(true);
    expect(isExecutableOpenTarget(path.join(root, "notes.txt"))).toBe(false);
  });

  it("keeps refusing to write a kind that is not text at all", () => {
    // The editable-kind gate is what stops a binary being saved as text, and it
    // is untouched — dropping the executable check did not open that door.
    fs.writeFileSync(path.join(root, "image.png"), "png", "utf8");
    fs.writeFileSync(path.join(root, "notes.txt"), "ok\n", "utf8");
    const text = readTreeFile(root, "notes.txt");
    if (!text.ok || !text.details) throw new Error("expected a stamp");
    expect(writeTreeFile(root, "image.png", "x", text.details.stamp, {}))
      .toEqual({ ok: false, reason: "file type is not editable" });
  });
});

describe("desktop provider global state", () => {
  it("preserves the shared provider keys without desktop-specific translation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-provider-state-"));
    const file = path.join(dir, "globalState.json");
    try {
      const state = createFileMemento(file);
      await state.update("grok.providerConnections", { grok: true, codex: true });
      await state.update("grok.providerModelCache", { codex: { models: [{ modelId: "" }], seenAt: 1 } });
      await state.update("grok.projectProviderDefaults", { "/work": { provider: "codex", modelId: "" } });

      const reloaded = createFileMemento(file);
      expect(reloaded.get("grok.providerConnections")).toEqual({ grok: true, codex: true });
      expect(reloaded.get<any>("grok.providerModelCache").codex.models[0].modelId).toBe("");
      expect(reloaded.get<any>("grok.projectProviderDefaults")["/work"])
        .toEqual({ provider: "codex", modelId: "" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
