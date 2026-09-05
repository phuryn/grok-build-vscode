/**
 * Shared workspace authorization + close-revocation helpers.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *  1. remote send with no cwd refuses when bound session cwd is closed
 *  2. image handle under closed folder is refused
 *  3. held/adopted session cannot resume in a closed folder
 *  4. sidebar revoke on removeProjectFolder (source structure)
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizedListCwd,
  cwdIsAuthorized,
  filterEntriesByAuthorizedCwd,
  imageHandlesToRevoke,
  imagePathStillAuthorized,
  pathBoundToClosedFolder,
  remoteBoundCwdStillAuthorized,
  sessionBoundToClosedFolder,
  sessionCwdFromGrokMediaPath,
} from "../src/workspace-auth";
import { pathsEqual } from "../src/worktree";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebarSrc = () =>
  fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");

describe("cwdIsAuthorized", () => {
  it("accepts only exact members of the authorized set", () => {
    const authorized = ["/work/a", "/work/a-wt"];
    expect(cwdIsAuthorized("/work/a", authorized, pathsEqual)).toBe(true);
    expect(cwdIsAuthorized("/work/a-wt", authorized, pathsEqual)).toBe(true);
    expect(cwdIsAuthorized("/work/closed", authorized, pathsEqual)).toBe(false);
    expect(cwdIsAuthorized(undefined, authorized, pathsEqual)).toBe(false);
    expect(cwdIsAuthorized("/work/a", [], pathsEqual)).toBe(false);
  });
});

describe("authorizedListCwd / filterEntriesByAuthorizedCwd (outbound send gate)", () => {
  it("refuses a closed project's cwd even when per-tab state still names it", () => {
    // Production: after revoke, RemoteClientState may leave cwd at the closed
    // path so selectRepo is required. Outbound builders must not scan that
    // catalog — they consult authorizedListCwd at build time.
    const open = ["/work/open"];
    const closed = "/work/closed";
    expect(authorizedListCwd(closed, open, pathsEqual)).toBeUndefined();
    expect(authorizedListCwd("/work/open", open, pathsEqual)).toBe("/work/open");
    expect(authorizedListCwd(undefined, open, pathsEqual)).toBeUndefined();
  });

  it("filters pinned/session entries so a closed repo never appears in the payload", () => {
    const authorized = ["/work/open"];
    const entries = [
      { id: "a", cwd: "/work/open", displayName: "ok" },
      { id: "b", cwd: "/work/closed", displayName: "leak" },
      { id: "c", cwd: undefined as string | undefined, displayName: "no-cwd" },
    ];
    const kept = filterEntriesByAuthorizedCwd(entries, authorized, pathsEqual);
    expect(kept.map((e) => e.id)).toEqual(["a"]);
  });

  it("mutation: trusting stale tab cwd without authorizedListCwd reopens the leak", () => {
    // Simulates postSessionsList / buildRemoteSnapshot using remoteClients.cwd
    // alone as the list scope after a project close.
    const tabCwd = "/work/closed";
    const authorized = ["/work/open"];
    const buggyWouldScan = tabCwd; // old path: always scan tab cwd
    expect(buggyWouldScan).toBe("/work/closed");
    const fixed = authorizedListCwd(tabCwd, authorized, pathsEqual);
    expect(fixed).toBeUndefined(); // empty sessions list, no disk scan
  });
});

describe("remoteBoundCwdStillAuthorized (no-cwd remote ops)", () => {
  it("refuses a send bound to a closed folder even when the message has no cwd", () => {
    // Production: handleRemoteMessage checks bound session/client cwd for every
    // remote op except selectRepo. A plain send carries no cwd and used to skip
    // allowRemoteRepoTarget's catalog check entirely.
    const open = ["/work/open"];
    const closed = "/work/closed";
    expect(remoteBoundCwdStillAuthorized(closed, open, pathsEqual)).toBe(false);
    expect(remoteBoundCwdStillAuthorized("/work/open", open, pathsEqual)).toBe(true);
    expect(remoteBoundCwdStillAuthorized(undefined, open, pathsEqual)).toBe(false);
  });

  it("mutation: skipping the bound-cwd check reopens the hole", () => {
    // Old allowRemoteRepoTarget default branch: messages without cwd → true.
    const allowRemoteRepoTargetDefault = (_msgType: string, hasCwd: boolean) =>
      hasCwd ? false : true; // buggy: no-cwd always allowed
    expect(allowRemoteRepoTargetDefault("send", false)).toBe(true);

    // Fixed path: still check bound session cwd.
    const bound = "/work/closed";
    const authorized = ["/work/open"];
    const fixed =
      allowRemoteRepoTargetDefault("send", false) &&
      remoteBoundCwdStillAuthorized(bound, authorized, pathsEqual);
    expect(fixed).toBe(false);
  });
});

describe("image handle revocation", () => {
  it("lists handles whose paths sit under a closed folder", () => {
    const closed = path.resolve("/work/closed");
    const open = path.resolve("/work/open");
    const handles = new Map<string, string>([
      ["h1", path.join(closed, "shot.png")],
      ["h2", path.join(open, "ok.png")],
      ["h3", closed],
    ]);
    const revoked = imageHandlesToRevoke(handles, closed, pathsEqual);
    expect(revoked.sort()).toEqual(["h1", "h3"].sort());
  });

  it("refuses imagePathStillAuthorized for a closed-folder path", () => {
    const closed = path.resolve("/work/closed");
    const open = path.resolve("/work/open");
    const img = path.join(closed, "secret.png");
    expect(imagePathStillAuthorized(img, [open], { sameCwd: pathsEqual })).toBe(false);
    expect(imagePathStillAuthorized(img, [open, closed], { sameCwd: pathsEqual })).toBe(true);
  });

  it("allows grok session media only when the catalog cwd is still authorized", () => {
    const grokHome = path.resolve("/home/u/.grok");
    const repo = path.resolve("/work/open");
    const media = path.join(
      grokHome,
      "sessions",
      encodeURIComponent(repo),
      "images",
      "1.jpg",
    );
    expect(sessionCwdFromGrokMediaPath(media, grokHome)).toBe(repo);
    expect(
      imagePathStillAuthorized(media, [repo], {
        grokHome,
        sameCwd: pathsEqual,
        isTrustedGeneratedMedia: () => true,
      }),
    ).toBe(true);
    expect(
      imagePathStillAuthorized(media, [path.resolve("/work/other")], {
        grokHome,
        sameCwd: pathsEqual,
        isTrustedGeneratedMedia: () => true,
      }),
    ).toBe(false);
  });
});

describe("sessionBoundToClosedFolder / held resume", () => {
  it("matches process cwd and worktree bindings", () => {
    const closed = "/work/closed";
    expect(sessionBoundToClosedFolder(closed, undefined, undefined, closed, pathsEqual)).toBe(true);
    expect(
      sessionBoundToClosedFolder("/wt", "/wt", closed, closed, pathsEqual),
    ).toBe(true);
    expect(
      sessionBoundToClosedFolder("/work/open", undefined, undefined, closed, pathsEqual),
    ).toBe(false);
  });

  it("held session with closed cwd is not authorized (resume must refuse)", () => {
    const heldCwd = "/work/closed";
    const authorized = ["/work/open"];
    // Same predicate startSession / openSessionReserved use after close.
    expect(cwdIsAuthorized(heldCwd, authorized, pathsEqual)).toBe(false);
  });
});

describe("pathBoundToClosedFolder", () => {
  it("is segment-safe (not a string prefix)", () => {
    expect(pathBoundToClosedFolder("/work/closed-extra/x", "/work/closed", pathsEqual)).toBe(
      false,
    );
    expect(pathBoundToClosedFolder("/work/closed/x", "/work/closed", pathsEqual)).toBe(true);
  });
});

describe("sidebar close-revocation wiring (source)", () => {
  it("removeProjectFolder revokes sessions, remote ownership, and image handles", () => {
    const src = sidebarSrc();
    expect(src).toContain("revokeClosedProjectFolder");
    expect(src).toContain("isAuthorizedCwd");
    expect(src).toContain("remoteBoundCwdStillAuthorized");
    expect(src).toContain("invalidateImageHandlesUnder");
    expect(src).toContain("isImagePathAuthorizedNow");

    const removeStart = src.indexOf("async removeProjectFolder(");
    expect(removeStart).toBeGreaterThan(0);
    const removeEnd = src.indexOf("private revokeClosedProjectFolder", removeStart);
    const removeBody = src.slice(removeStart, removeEnd);
    // Revoke must run after successful removeWorkspaceFolder, before UI rehome.
    expect(removeBody).toContain("revokeClosedProjectFolder(target)");
    expect(removeBody).toContain("removeWorkspaceFolder(target)");

    // Bound-cwd gate on remote ops (not only cwd-bearing messages).
    const remoteStart = src.indexOf("private handleRemoteMessage(");
    const remoteBody = src.slice(remoteStart, remoteStart + 2500);
    expect(remoteBody).toContain("remoteBoundCwdStillAuthorized");
    expect(remoteBody).toContain('m.type !== "selectRepo"');

    // startSession refuses unauthorized target.cwd even with resumeId.
    const startStart = src.indexOf("private async startSessionBody(");
    // A SEARCH BOUND, not a measurement: it only has to reach past the
    // method's prologue. 1200 stopped doing that the moment the open clock
    // added a few lines at the top, and the gate it looks for (at ~1460 chars)
    // read as deleted when it had merely moved.
    const startBody = src.slice(startStart, startStart + 2400);
    expect(startBody).toContain("isAuthorizedCwd(target.cwd)");
    expect(startBody).toContain("refused startSession");

    // Held-session adopt refuses closed folder.
    expect(src).toContain("refused held-session adopt");

    // requestImageFull revalidates.
    const imgStart = src.indexOf('case "requestImageFull"');
    const imgBody = src.slice(imgStart, imgStart + 800);
    expect(imgBody).toContain("isImagePathAuthorizedNow");

    // Mutation: if revoke is only a catalog refresh, the test fails.
    expect(removeBody).not.toMatch(
      /removeWorkspaceFolder\(target\)[\s\S]*return;\s*\n\s*const next/,
    );
  });

  it("single authorization query is consulted by remote + start + image paths", () => {
    const src = sidebarSrc();
    // The shared query exists once.
    const queryDef = src.indexOf("private isAuthorizedCwd(");
    expect(queryDef).toBeGreaterThan(0);
    // remoteTargetableCwd delegates — not a second open-set walk.
    const remoteTarget = src.indexOf("private remoteTargetableCwd(");
    const remoteTargetBody = src.slice(remoteTarget, remoteTarget + 200);
    // Delegates to the shared authorized set, narrowed for remotes — not a
    // second walk of the open set, and not the catalog (which is wider).
    expect(remoteTargetBody).toContain("authorizedSessionCwds");
    expect(remoteTargetBody).not.toContain("localRepoCatalogEntries");
  });

  it("every outbound remote builder enforces authorizedListCwd at build time", () => {
    const src = sidebarSrc();
    // buildSessionsList: gate before disk scan.
    const listStart = src.indexOf("private buildSessionsList(");
    const listEnd = src.indexOf("private sessionDisplayName(", listStart);
    const listBody = src.slice(listStart, listEnd > listStart ? listEnd : listStart + 800);
    expect(listBody).toContain("authorizedListCwd");
    expect(listBody).toContain("authorizedSessionCwds");
    // Empty list when unauthorized (no indexSessions for closed cwd).
    expect(listBody).toMatch(/type:\s*"sessions"/);
    expect(listBody).toContain("entries: []");

    // buildPinnedSessions: skip unauthorized pin buckets.
    const pinStart = src.indexOf("private buildPinnedSessions(");
    const pinEnd = src.indexOf("private postPinnedSessions(", pinStart);
    const pinBody = src.slice(pinStart, pinEnd);
    expect(pinBody).toContain("authorizedListCwd");
    expect(pinBody).toContain("filterEntriesByAuthorizedCwd");

    // buildRemoteSnapshot: buffer + sessions only for authorized session cwd.
    const snapStart = src.indexOf("private buildRemoteSnapshot(");
    const snapEnd = src.indexOf("private getHtml(", snapStart);
    const snapBody = src.slice(snapStart, snapEnd);
    expect(snapBody).toContain("authorizedListCwd");
    expect(snapBody).toContain("authorizedSessionCwds");
    expect(snapBody).toContain("buildSessionsList");
    expect(snapBody).toContain("buildPinnedSessions");
    // Must not assume revoke already cleared per-tab cwd.
    expect(snapBody).toMatch(/sessionCwdOk/);
    // Project-bearing fields scrubbed: never listCwd ?? closedTabCwd.
    expect(snapBody).toContain("buildRemoteReposMsg");
    expect(snapBody).toMatch(/cwd:\s*listCwd\s*\?\?\s*""/);
    expect(snapBody).not.toMatch(/selectedCwd:\s*cwd\b/);

    // localRepoCatalogEntries remains the catalog source (open folders desktop).
    expect(src).toContain("localRepoCatalogEntries");
    // Remote repos builder scrubs closed selectedCwd before the choke point.
    const reposMsgStart = src.indexOf("private buildRemoteReposMsg(");
    expect(reposMsgStart).toBeGreaterThan(0);
    const reposMsgBody = src.slice(reposMsgStart, reposMsgStart + 1600);
    expect(reposMsgBody).toContain("authorizedListCwd");
    expect(reposMsgBody).toContain('selectedCwd');
    // Rows for removed projects cannot reach the wire.
    expect(reposMsgBody).toContain("entries.filter((r) => cwdIsAuthorized(r.cwd, authorized, pathsEqual))");
  });

  it("RemoteUplink is the sole socket write path and enforces project auth", () => {
    const src = sidebarSrc();
    const uplinkSrc = fs.readFileSync(path.join(root, "src", "remote-uplink.ts"), "utf8");

    // Hard boundary lives in RemoteUplink — every HostMsg write (broadcast,
    // broadcastTo, snapshot) goes through mayDeliverRemoteHostMsg there.
    expect(uplinkSrc).toContain("mayDeliverRemoteHostMsg");
    expect(uplinkSrc).toContain("authorizedSnapshot");
    expect(uplinkSrc).toContain("filterAuthorizedOutbound");
    expect(uplinkSrc).toMatch(/authorizeWrite/);
    // Snapshot catch-up must not send opts.snapshot() bytes raw.
    expect(uplinkSrc).toMatch(/authorizedSnapshot\([\s\S]*snapshotFrame/);
    expect(uplinkSrc).not.toMatch(
      /snapshotFrame\(\s*frame\.clientId\s*,\s*this\.opts\.snapshot\(/,
    );

    // Sidebar wires live auth into the uplink (not a one-shot capture).
    expect(src).toMatch(/auth:\s*\{/);
    expect(src).toContain("authorizedCwds: () => this.authorizedSessionCwds()");
    expect(src).toContain("scopeCwdForClient:");

    // deliverRemote remains the live fan-out orchestrator (transform + postTap)
    // and still pre-gates; it must hand scope to broadcastTo.
    const deliverStart = src.indexOf("private deliverRemote(");
    expect(deliverStart).toBeGreaterThan(0);
    const deliverEnd = src.indexOf("private sendRemoteClient(", deliverStart);
    const deliverBody = src.slice(deliverStart, deliverEnd);
    expect(deliverBody).toContain("mayDeliverRemoteHostMsg");
    expect(deliverBody).toMatch(/uplink\?\.broadcastTo\(/);
    expect(deliverBody).toMatch(/broadcastTo\(\[\.\.\.clientIds\],\s*out,\s*scopeCwd\)/);
    // JSDoc above deliverRemote must not claim it is the sole write path.
    const deliverDoc = src.slice(Math.max(0, deliverStart - 800), deliverStart);
    expect(deliverDoc).toMatch(/hard authorization boundary is inside RemoteUplink/i);
    expect(deliverDoc).not.toMatch(/Sole uplink write path for HostMsgs/i);

    // Fan-out helpers must route through deliverRemote, not open their own uplink.
    for (const name of [
      "private sendRemoteClient(",
      "private sendRemoteRepo(",
      "private sendRemoteSession(",
      "private sendRemoteHistorySnapshot(",
      "private broadcastRemoteDevice(",
    ]) {
      const i = src.indexOf(name);
      expect(i, name).toBeGreaterThan(0);
    }
    const histStart = src.indexOf("private sendRemoteHistorySnapshot(");
    const histBody = src.slice(histStart, histStart + 600);
    expect(histBody).toContain("isAuthorizedCwd");
    expect(histBody).toContain("dropped history snapshot");

    // No other uplink.broadcast* outside deliverRemote.
    const uplinkWrites = [...src.matchAll(/uplink\?\.broadcast(?:To)?\(/g)];
    expect(uplinkWrites.length).toBe(1);
    for (const m of uplinkWrites) {
      expect(m.index! >= deliverStart && m.index! < deliverEnd).toBe(true);
    }
  });

  it("toggleSessionPin refuses unauthorized home cwd (no protocol change)", () => {
    const src = sidebarSrc();
    const pinStart = src.indexOf("private async toggleSessionPin(");
    const pinEnd = src.indexOf("private buildPinnedSessions(", pinStart);
    const pinBody = src.slice(pinStart, pinEnd);
    expect(pinBody).toContain("isAuthorizedCwd(home)");
    // Must not mutate when home is only in cache/metadata after project close.
    expect(pinBody).toMatch(/if\s*\(\s*!this\.isAuthorizedCwd\(home\)\s*\)\s*return null/);
  });

  it("voiceConfigured is project-scoped (classification + scoped send)", () => {
    // Cross-project metadata leak if classification is "none" or the live
    // fan-out omits scopeCwd — a closed-project tab kept the prior sendPhrase.
    const policy = fs.readFileSync(path.join(root, "src", "remote-policy.ts"), "utf8");
    expect(policy).toMatch(/voiceConfigured:\s*"scope"/);
    expect(policy).not.toMatch(/voiceConfigured:\s*"none"/);

    const src = sidebarSrc();
    const start = src.indexOf("private postVoiceConfigured(");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("private voiceSetting<", start);
    const body = src.slice(start, end);
    // Must pass the resolved project cwd as scope (3rd arg), not bare sendRemoteClient(id, msg).
    expect(body).toMatch(
      /sendRemoteClient\(\s*clientId\s*,\s*remoteMsg\s*,\s*remoteCwd\s*\)/,
    );
    expect(body).toContain("cwdIfPresent");
    expect(body).not.toContain("remoteSessionFor");
    expect(body).not.toMatch(/remoteClients\.cwd\(/);
  });

  it("host-wide remote fan-out skips a tab with no project instead of throwing", () => {
    const src = sidebarSrc();
    const slices = [
      src.slice(src.indexOf("private postSessionsList("), src.indexOf("private buildSessionsList(")),
      src.slice(src.indexOf("private buildRemoteReposMsg("), src.indexOf("private sendRemoteRepoCatalog(")),
      src.slice(src.indexOf("private refreshRemoteRepoPreview("), src.indexOf("private sessionHasLiveOwner(")),
      src.slice(src.indexOf("private pushDot("), src.indexOf("private dotForId(")),
    ];
    for (const body of slices) {
      expect(body.length).toBeGreaterThan(40);
      expect(body).toContain("cwdIfPresent");
      expect(body).not.toMatch(/remoteClients\.cwd\(/);
    }
    expect(src).toMatch(/scopeCwdForClient:[\s\S]*?cwdIfPresent\(clientId\)/);
  });

  it("revokeClosedProjectFolder cancels local and remote voice for the closed folder", () => {
    const src = sidebarSrc();
    const revokeStart = src.indexOf("private revokeClosedProjectFolder(");
    const revokeBody = src.slice(revokeStart, revokeStart + 900);
    expect(revokeBody).toContain("revokeVoiceForClosedFolder");

    const voiceStart = src.indexOf("private revokeVoiceForClosedFolder(");
    expect(voiceStart).toBeGreaterThan(0);
    const voiceBody = src.slice(voiceStart, voiceStart + 1200);
    expect(voiceBody).toContain("stopVoiceInput");
    expect(voiceBody).toContain("dropRemoteVoice");
    expect(voiceBody).toContain("localVoiceCwd");
    expect(voiceBody).toContain("credentialCwd");
  });
});
