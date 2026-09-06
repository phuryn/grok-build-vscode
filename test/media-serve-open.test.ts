/**
 * Pure open-path resolution for chat links to session-generated media.
 * Workspace wins when the file exists; otherwise safe images|videos/ links
 * resolve under the session dir and must stay trusted under grok home.
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  inferCodexGeneratedImagePath,
  isTrustedCodexGeneratedImagePath,
  isSafeRelativeGeneratedMediaLink,
  isTrustedGeneratedMediaPath,
  resolveChatOpenFilePath,
  resolveSessionGeneratedMediaPath,
} from "../src/media-serve";
import { keepsCanonicalDirectChildIdentity } from "../src/sessions";

function sessionLayout(grokHome: string, sessionId = "sess-1") {
  // Host path module so Windows CI gets drive/separator-correct absolutes.
  const sessionDir = path.join(grokHome, "sessions", "cwd-enc", sessionId);
  const imagesDir = path.join(sessionDir, "images");
  const videosDir = path.join(sessionDir, "videos");
  return {
    grokHome,
    sessionDir,
    imagesDir,
    videosDir,
    image: path.join(imagesDir, "1.jpg"),
    video: path.join(videosDir, "1.mp4"),
  };
}

describe("Codex generated-image path inference", () => {
  const codexHome = path.resolve("fake-codex-home");
  const sessionId = "0198f0d1-2b3c-7d4e-8f50-123456789abc";
  const toolCallId = "exec-550e8400-e29b-41d4-a716-446655440000";

  it("accepts only UUID session ids and exec-UUID tool-call ids", () => {
    expect(inferCodexGeneratedImagePath(codexHome, sessionId, toolCallId)).toBe(
      path.resolve(codexHome, "generated_images", sessionId, `${toolCallId}.png`),
    );
    for (const hostile of ["..\\..", "../escape", "uuid.with.dots", "not-a-uuid"]) {
      expect(inferCodexGeneratedImagePath(codexHome, hostile, toolCallId)).toBeUndefined();
      expect(inferCodexGeneratedImagePath(codexHome, sessionId, hostile)).toBeUndefined();
    }
  });

  it("refuses when the resolved candidate leaves generated_images", () => {
    const outside = path.resolve(codexHome, "outside.png");
    expect(inferCodexGeneratedImagePath(
      codexHome,
      sessionId,
      toolCallId,
      (...segments) => segments.length === 2
        ? path.resolve(...segments)
        : outside,
    )).toBeUndefined();
  });

  it("refuses a canonical target outside generated_images", () => {
    const candidate = path.resolve(codexHome, "generated_images", sessionId, `${toolCallId}.png`);
    const outside = path.resolve(codexHome, "outside.png");
    expect(isTrustedCodexGeneratedImagePath(candidate, codexHome, (value) =>
      path.resolve(value) === candidate ? outside : path.resolve(value),
    )).toBe(false);
  });
});

describe("isSafeRelativeGeneratedMediaLink", () => {
  it("accepts images|videos/<file> with media extensions", () => {
    expect(isSafeRelativeGeneratedMediaLink("images/1.jpg")).toBe(true);
    expect(isSafeRelativeGeneratedMediaLink("videos/1.mp4")).toBe(true);
    expect(isSafeRelativeGeneratedMediaLink("images/shot.PNG")).toBe(true);
    expect(isSafeRelativeGeneratedMediaLink("videos\\clip.webm")).toBe(true);
  });

  it("refuses traversal, absolute, UNC, schemes, and non-media", () => {
    expect(isSafeRelativeGeneratedMediaLink("images/../../../.grok/auth.json")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("../../etc/passwd")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("C:\\Windows\\x.png")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("\\\\server\\share\\x.png")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("file:///x.png")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("images/notes.txt")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("docs/images/1.jpg")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("images/")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("images/sub/1.jpg")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("/images/1.jpg")).toBe(false);
    expect(isSafeRelativeGeneratedMediaLink("images/1.jpg\0.png")).toBe(false);
  });
});

describe("resolveSessionGeneratedMediaPath", () => {
  const layout = sessionLayout(path.join(path.resolve("."), "fake-grok-home"));

  it("resolves a safe relative link under the session dir when trusted", () => {
    const got = resolveSessionGeneratedMediaPath(
      "images/1.jpg",
      layout.sessionDir,
      layout.grokHome,
      (p) => path.resolve(p),
    );
    expect(got).toBe(path.resolve(layout.image));
  });

  it("refuses a symlink whose realpath leaves the grok home", () => {
    const outside = path.resolve(path.join(path.dirname(layout.grokHome), "evil.jpg"));
    const got = resolveSessionGeneratedMediaPath(
      "images/1.jpg",
      layout.sessionDir,
      layout.grokHome,
      (p) => {
        if (path.resolve(p) === path.resolve(layout.image)) return outside;
        return path.resolve(p);
      },
    );
    expect(got).toBeNull();
  });

  it("refuses a relative link whose realpath lands in a sibling session", () => {
    // sessionA/images → sessionB/images (still under grok home). Lexical join
    // stays under sessionA; home trust passes; sessionDir canonical trust fails.
    // Mutation: drop isTrustedGeneratedMediaPath(joined, sessionDir, …) and
    // this test fails (returns the joined path under session A).
    const siblingSession = path.join(path.dirname(layout.sessionDir), "sess-sibling");
    const siblingImage = path.join(siblingSession, "images", "1.jpg");
    const got = resolveSessionGeneratedMediaPath(
      "images/1.jpg",
      layout.sessionDir,
      layout.grokHome,
      (p) => {
        if (path.resolve(p) === path.resolve(layout.image)) {
          return path.resolve(siblingImage);
        }
        return path.resolve(p);
      },
    );
    expect(got).toBeNull();
    // Home-only trust would still accept — that is exactly the gap without
    // the sessionDir half of the AND.
    expect(
      isTrustedGeneratedMediaPath(path.resolve(layout.image), layout.grokHome, (p) => {
        if (path.resolve(p) === path.resolve(layout.image)) {
          return path.resolve(siblingImage);
        }
        return path.resolve(p);
      }),
    ).toBe(true);
    expect(
      isTrustedGeneratedMediaPath(path.resolve(layout.image), layout.sessionDir, (p) => {
        if (path.resolve(p) === path.resolve(layout.image)) {
          return path.resolve(siblingImage);
        }
        return path.resolve(p);
      }),
    ).toBe(false);
  });

  it("refuses when sessionDir itself is a junction onto another session", () => {
    // sessions/<cwd>/<id> → foreign session under another catalog. Containment
    // against realpath(sessionDir) would accept images/1.jpg under the foreign
    // dir; keepsCanonicalDirectChildIdentity(sessionDir, catalog) refuses first.
    // Mutation: drop that identity fence in resolveSessionGeneratedMediaPath
    // and this test fails (returns the joined path).
    const foreignSession = path.join(
      layout.grokHome,
      "sessions",
      "other-cwd-enc",
      "sess-foreign",
    );
    const foreignImage = path.join(foreignSession, "images", "1.jpg");
    const realpathMap = (p: string): string => {
      const resolved = path.resolve(p);
      const sess = path.resolve(layout.sessionDir);
      if (resolved === sess || resolved.startsWith(sess + path.sep)) {
        return path.join(path.resolve(foreignSession), path.relative(sess, resolved));
      }
      return resolved;
    };
    // Prove the containment hole the fence closes:
    expect(
      isTrustedGeneratedMediaPath(
        path.resolve(layout.image),
        layout.sessionDir,
        realpathMap,
      ),
    ).toBe(true);
    expect(
      isTrustedGeneratedMediaPath(path.resolve(layout.image), layout.grokHome, realpathMap),
    ).toBe(true);
    // realpath(sessionDir) is under another catalog (parent + leaf diverge).
    expect(path.dirname(realpathMap(layout.sessionDir))).toBe(
      path.resolve(layout.grokHome, "sessions", "other-cwd-enc"),
    );
    expect(path.dirname(realpathMap(layout.sessionDir))).not.toBe(
      path.dirname(path.resolve(layout.sessionDir)),
    );
    expect(path.basename(realpathMap(layout.sessionDir))).not.toBe(
      path.basename(path.resolve(layout.sessionDir)),
    );

    const got = resolveSessionGeneratedMediaPath(
      "images/1.jpg",
      layout.sessionDir,
      layout.grokHome,
      realpathMap,
    );
    expect(got).toBeNull();
    void foreignImage;
  });

  it("refuses when the catalog is a junction relocating within ~/.grok", () => {
    // sessions/<leaf> → other/<leaf>: same basename, still under home. Session
    // identity against dirname(sessionDir) PASSES (catalog and session remap
    // together, so realpath(sessionDir) is still a direct child of
    // realpath(catalog) with the same id). Home + session containment also
    // pass. Only the catalog-under-<grokHome>/sessions fence refuses.
    // Mutation: drop keepsCanonicalDirectChildIdentity(sessionCatalog,
    // sessionsRoot, …) in resolveSessionGeneratedMediaPath and this test
    // fails (returns the joined path under the relocated tree).
    const catalog = path.dirname(path.resolve(layout.sessionDir));
    const leaf = path.basename(catalog);
    const relocated = path.join(path.resolve(layout.grokHome), "other", leaf);
    const realpathMap = (p: string): string => {
      const resolved = path.resolve(p);
      const cat = path.resolve(catalog);
      if (resolved === cat || resolved.startsWith(cat + path.sep)) {
        return path.join(path.resolve(relocated), path.relative(cat, resolved));
      }
      return resolved;
    };

    // Prove the halves that are NOT enough alone:
    expect(path.basename(realpathMap(catalog))).toBe(leaf);
    expect(
      isTrustedGeneratedMediaPath(path.resolve(layout.image), layout.sessionDir, realpathMap),
    ).toBe(true);
    expect(
      isTrustedGeneratedMediaPath(path.resolve(layout.image), layout.grokHome, realpathMap),
    ).toBe(true);
    // Session-dir identity vs its own dirname still passes through the junction.
    expect(
      keepsCanonicalDirectChildIdentity(
        layout.sessionDir,
        catalog,
        realpathMap,
        process.platform,
      ),
    ).toBe(true);
    // Relocated parent is under home but not the sessions root.
    expect(path.dirname(realpathMap(catalog))).toBe(
      path.resolve(layout.grokHome, "other"),
    );
    expect(path.dirname(realpathMap(catalog))).not.toBe(
      path.resolve(path.join(layout.grokHome, "sessions")),
    );

    const got = resolveSessionGeneratedMediaPath(
      "images/1.jpg",
      layout.sessionDir,
      layout.grokHome,
      realpathMap,
    );
    expect(got).toBeNull();
  });

  it("still accepts when the whole grok home sits under a symlink", () => {
    // Ancestors only: every path under the logical home remaps to a real tree
    // with the same relative layout. Root and file canonicalize consistently,
    // so both sessionDir and grokHome trust still pass.
    const logicalHome = path.resolve(layout.grokHome);
    const realHome = path.resolve(path.dirname(layout.grokHome), "real-grok-home");
    const remap = (p: string): string => {
      const r = path.resolve(p);
      if (r === logicalHome || r.startsWith(logicalHome + path.sep)) {
        return path.join(realHome, path.relative(logicalHome, r));
      }
      return r;
    };
    const got = resolveSessionGeneratedMediaPath(
      "images/1.jpg",
      layout.sessionDir,
      layout.grokHome,
      remap,
    );
    expect(got).toBe(path.resolve(layout.image));
  });

  it("refuses non-media and traversal relatives", () => {
    expect(
      resolveSessionGeneratedMediaPath(
        "images/notes.txt",
        layout.sessionDir,
        layout.grokHome,
      ),
    ).toBeNull();
    expect(
      resolveSessionGeneratedMediaPath(
        "images/../../../.grok/auth.json",
        layout.sessionDir,
        layout.grokHome,
      ),
    ).toBeNull();
  });
});

describe("resolveChatOpenFilePath", () => {
  const workspace = path.join(path.resolve("."), "fake-workspace");
  const layout = sessionLayout(path.join(path.resolve("."), "fake-grok-home-open"));
  const existing = new Set<string>();

  const exists = (p: string) => existing.has(path.resolve(p));
  const realpath = (p: string) => path.resolve(p);

  // #125: `~/Downloads/x.md` is not absolute, so it used to fall through to
  // path.resolve(cwd, "~/Downloads/x.md") — a directory literally named `~`
  // inside the workspace — and the click reported "file not found".
  it("expands a leading ~ to the home directory (#125)", () => {
    existing.clear();
    const home = path.join(path.resolve("."), "fake-home");
    const got = resolveChatOpenFilePath({
      rawPath: "~/Downloads/grok-link-demo.md",
      workspaceRoots: [workspace],
      exists,
      realpath,
      homeDir: home,
    });
    expect(got).toBe(path.join(home, "Downloads", "grok-link-demo.md"));
    // and it must NOT have been treated as a workspace-relative name
    expect(got.startsWith(workspace)).toBe(false);
  });

  it("normalizes file:// URIs to local filesystem paths", () => {
    const ws = path.resolve("/workspace");
    const gotWindows = resolveChatOpenFilePath({
      rawPath: "file:///C:/work/project/file.ts",
      workspaceRoots: [ws],
      exists: () => false,
      homeDir: "/home/user",
    });
    expect(gotWindows).toBe("C:/work/project/file.ts");

    const gotEncoded = resolveChatOpenFilePath({
      rawPath: "file:///C:/My%20Project/file%20name.ts",
      workspaceRoots: [ws],
      exists: () => false,
      homeDir: "/home/user",
    });
    expect(gotEncoded).toBe("C:/My Project/file name.ts");

    const gotPosix = resolveChatOpenFilePath({
      rawPath: "file:///home/user/project/file.ts",
      workspaceRoots: [ws],
      exists: () => false,
      homeDir: "/home/user",
    });
    expect(gotPosix).toBe("/home/user/project/file.ts");
  });

  it("leaves ~otheruser and a mid-path ~ alone, and passes ~ through with no homeDir", () => {
    existing.clear();
    const home = path.join(path.resolve("."), "fake-home");
    // Another user's home needs the password database to resolve; guessing a
    // sibling of ours would be wrong, so it stays as written.
    expect(resolveChatOpenFilePath({
      rawPath: "~someone/notes.md",
      workspaceRoots: [workspace],
      exists,
      realpath,
      homeDir: home,
    })).toBe(path.resolve(workspace, "~someone/notes.md"));
    // A tilde that is not the first character is an ordinary filename.
    expect(resolveChatOpenFilePath({
      rawPath: "docs/~draft.md",
      workspaceRoots: [workspace],
      exists,
      realpath,
      homeDir: home,
    })).toBe(path.resolve(workspace, "docs/~draft.md"));
    // No homeDir supplied → nothing to expand to, so behaviour is unchanged.
    expect(resolveChatOpenFilePath({
      rawPath: "~/Downloads/x.md",
      workspaceRoots: [workspace],
      exists,
      realpath,
    })).toBe(path.resolve(workspace, "~/Downloads/x.md"));
  });

  it("resolves relative images/1.jpg to the session dir when workspace file is absent", () => {
    existing.clear();
    // Session media exists for trust lexical fallback; exists check on workspace misses.
    existing.add(path.resolve(layout.image));
    const got = resolveChatOpenFilePath({
      rawPath: "images/1.jpg",
      workspaceRoots: [workspace],
      sessionDir: layout.sessionDir,
      grokHome: layout.grokHome,
      exists,
      realpath,
    });
    expect(got).toBe(path.resolve(layout.image));
  });

  it("opens the WORKSPACE file when images/1.jpg exists there (no regression)", () => {
    existing.clear();
    const workspaceImg = path.resolve(workspace, "images/1.jpg");
    existing.add(workspaceImg);
    existing.add(path.resolve(layout.image));
    const got = resolveChatOpenFilePath({
      rawPath: "images/1.jpg",
      workspaceRoots: [workspace],
      sessionDir: layout.sessionDir,
      grokHome: layout.grokHome,
      exists,
      realpath,
    });
    expect(got).toBe(workspaceImg);
  });

  it("resolves videos/1.mp4 to the session dir when workspace file is absent", () => {
    existing.clear();
    existing.add(path.resolve(layout.video));
    const got = resolveChatOpenFilePath({
      rawPath: "videos/1.mp4",
      workspaceRoots: [workspace],
      sessionDir: layout.sessionDir,
      grokHome: layout.grokHome,
      exists,
      realpath,
    });
    expect(got).toBe(path.resolve(layout.video));
  });

  it("refuses traversal and absolute attack shapes for the session-media branch", () => {
    existing.clear();
    const attacks = [
      "images/../../../.grok/auth.json",
      "../../etc/passwd",
      "C:\\Windows\\x.png",
      "\\\\server\\share\\x.png",
      "file:///x.png",
      "images/notes.txt",
    ];
    for (const rawPath of attacks) {
      const got = resolveChatOpenFilePath({
        rawPath,
        workspaceRoots: [workspace],
        sessionDir: layout.sessionDir,
        grokHome: layout.grokHome,
        exists,
        realpath,
      });
      // Must not resolve into the session media tree for these inputs.
      expect(got === path.resolve(layout.image) || got === path.resolve(layout.video)).toBe(
        false,
      );
      if (isSafeRelativeGeneratedMediaLink(rawPath)) {
        expect.fail(`attack should not be a safe media link: ${rawPath}`);
      }
    }
  });

  it("refuses a session-media symlink that points outside the grok home", () => {
    existing.clear();
    const outside = path.resolve(path.join(path.dirname(layout.grokHome), "evil-escape.jpg"));
    const got = resolveChatOpenFilePath({
      rawPath: "images/1.jpg",
      workspaceRoots: [workspace],
      sessionDir: layout.sessionDir,
      grokHome: layout.grokHome,
      exists: () => false,
      realpath: (p) => {
        if (path.resolve(p) === path.resolve(layout.image)) return outside;
        return path.resolve(p);
      },
    });
    // Falls back to workspace join — must not be the escaped real target.
    expect(got).not.toBe(outside);
    expect(isTrustedGeneratedMediaPath(got, layout.grokHome, (p) => {
      if (path.resolve(p) === path.resolve(layout.image)) return outside;
      return path.resolve(p);
    })).toBe(false);
  });

  it("passes absolute paths through verbatim (no path.resolve rewrite)", () => {
    existing.clear();
    // Deliberate: do not path.resolve — on win32 that would turn `/tmp/x.png`
    // into `C:\tmp\x.png`. Absolute branch is pass-through only.
    const absUnixStyle = "/tmp/x.png";
    expect(
      resolveChatOpenFilePath({
        rawPath: absUnixStyle,
        workspaceRoots: [workspace],
        sessionDir: layout.sessionDir,
        grokHome: layout.grokHome,
        exists,
        realpath,
      }),
    ).toBe(absUnixStyle);

    const absSession = path.resolve(layout.image);
    expect(
      resolveChatOpenFilePath({
        rawPath: absSession,
        workspaceRoots: [workspace],
        sessionDir: layout.sessionDir,
        grokHome: layout.grokHome,
        exists,
        realpath,
      }),
    ).toBe(absSession);
  });

  it("resolves a relative path via findInSubtree when direct candidate does not exist", () => {
    existing.clear();
    const subprojectFile = path.resolve(workspace, "subproject", "src", "file.ts");
    existing.add(subprojectFile);

    const got = resolveChatOpenFilePath({
      rawPath: "src/file.ts",
      workspaceRoots: [workspace],
      exists,
      realpath,
      findInSubtree: (root, rel) => {
        const candidate = path.resolve(root, "subproject", rel);
        return existing.has(candidate) ? candidate : undefined;
      },
    });
    expect(got).toBe(subprojectFile);
  });
});

/**
 * The wiring, not the pure function above.
 *
 * A relative link in a conversation's prose must resolve against the
 * CONVERSATION's repo, not the folder VS Code happens to have open. That has
 * always been true, but it only mattered once the rail made history
 * multi-workspace: a conversation from another project is now routinely on
 * screen, and resolving its links against the open folder would send every one
 * of them to a path in the wrong repo — silently, since a miss just offers to
 * create the file (`resolveChatOpenFilePath` falls back to joining the first
 * root when nothing exists).
 *
 * Source-level because `resolveChatOpenPath` is private and there is no sidebar
 * harness. Weak as tests go, but it fails on the one edit that would regress
 * this — swapping the session's cwd for the workspace root.
 */
describe("chat open path is rooted at the session", () => {
  it("passes the session's cwd as the only workspace root", async () => {
    const fs = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    // Newlines normalised: the repo checks out CRLF on Windows and the slice
    // below counts on "\n  }\n" meaning end-of-method.
    const src = fs
      .readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
        "utf8",
      )
      .replace(/\r\n/g, "\n");
    // Sliced by index rather than by a body-matching regex: the declaration's
    // return type is itself a braced block ending "\n  } {", so the obvious
    // lazy match — and a plain search for "\n  }" — both stop at the end of the
    // signature and never reach the call this has to inspect.
    const at = src.indexOf("private resolveChatOpenPath(");
    expect(at, "resolveChatOpenPath must still exist").toBeGreaterThan(-1);
    const end = src.indexOf("\n  }\n", at);
    expect(end).toBeGreaterThan(at);
    const body = src.slice(at, end);
    expect(body).toMatch(/workspaceRoots:\s*\[\s*this\.sessionCwd\(session\)\s*\]/);
    expect(body).not.toMatch(/workspaceRoots:\s*\[\s*this\.workspaceRoot\(\)/);
  });
});
