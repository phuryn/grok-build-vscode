import { describe, it, expect } from "vitest";
import {
  INBOUND_DISPOSITION,
  OUTBOUND_DISPOSITION,
  OUTBOUND_PROJECT_AUTH,
  REMOTE_REQUIRES_BOUND_SESSION,
  remoteRequiresBoundSession,
  allowFromRemote,
  allowRemoteRepoTarget,
  bracketRemoteSnapshot,
  mayDeliverRemoteHostMsg,
  repoSessionsMessageForRemote,
  routinesMessageForRemote,
  repoScopeFor,
  sessionForRequest,
  sessionCwdBelongsToRepo,
  shouldAdoptDeskSession,
  inlineMediaForRemote,
  mediaMimeFromPath,
  transformHostMsgForRemote,
  REMOTE_HISTORY_BYTE_LIMIT,
  MAX_REMOTE_MEDIA_BYTES,
  MAX_REMOTE_THUMBNAIL_BYTES,
  type MediaInlineDeps,
  capabilitiesForRemote,
  DESK_ONLY_CAPABILITIES,
} from "../src/remote-policy";
import { HOST_MESSAGE_TYPES, WEBVIEW_MESSAGE_TYPES, type HostMsg } from "../src/protocol";
import { connectorViews } from "../src/mcp-connectors";
import { pathsEqual } from "../src/worktree";

const sorted = (a: readonly string[]) => [...a].sort();

describe("remote-policy classification tables", () => {
  // tsc already forces this via Record<Union["type"], …>; the runtime assert
  // guards the compiled-JS path the same way protocol.test.ts does.
  it("classifies every WebviewMsg type (no drift behind the protocol)", () => {
    expect(sorted(Object.keys(INBOUND_DISPOSITION))).toEqual(sorted(WEBVIEW_MESSAGE_TYPES));
  });

  it("classifies every WebviewMsg type for bound-session enforcement", () => {
    expect(sorted(Object.keys(REMOTE_REQUIRES_BOUND_SESSION))).toEqual(sorted(WEBVIEW_MESSAGE_TYPES));
    expect(remoteRequiresBoundSession("send")).toBe(true);
    expect(remoteRequiresBoundSession("permissionAnswer")).toBe(true);
    expect(remoteRequiresBoundSession("resumeSession")).toBe(false);
    expect(remoteRequiresBoundSession("newSession")).toBe(false);
    expect(remoteRequiresBoundSession("selectRepo")).toBe(false);
    expect(remoteRequiresBoundSession("listSessions")).toBe(false);
  });

  it("classifies every HostMsg type", () => {
    expect(sorted(Object.keys(OUTBOUND_DISPOSITION))).toEqual(sorted(HOST_MESSAGE_TYPES));
  });

  it("classifies every HostMsg type for project-scope authorization", () => {
    expect(sorted(Object.keys(OUTBOUND_PROJECT_AUTH))).toEqual(sorted(HOST_MESSAGE_TYPES));
  });

  it("keeps the load-bearing classifications from the design doc", () => {
    expect(INBOUND_DISPOSITION.ready).toBe("control");
    expect(INBOUND_DISPOSITION.send).toBe("propose");
    expect(INBOUND_DISPOSITION.steerSend).toBe("propose");
    expect(INBOUND_DISPOSITION.turnFeedback).toBe("propose");
    expect(INBOUND_DISPOSITION.uploadFile).toBe("propose");
    // Workspace file mutation — propose (not view); existing files only.
    expect(INBOUND_DISPOSITION.writeProjectFile).toBe("propose");
    expect(INBOUND_DISPOSITION.permissionAnswer).toBe("full");
    expect(INBOUND_DISPOSITION.exitPlanAnswer).toBe("full");
    expect(INBOUND_DISPOSITION.logout).toBe("host-local");
    // Moved off host-local on 2026-08-26 when the handler stopped opening a
    // terminal for a remote and started running the CLI's headless device-code
    // flow instead. The asymmetry with `logout` directly above is the point:
    // signing in adds an option using a credential the user obtains themselves
    // from the vendor, and signing out takes one away from every surface at
    // once. If a future change makes runGrokLogin spawn a terminal for a remote
    // again, this line has to go back with it.
    expect(INBOUND_DISPOSITION.runGrokLogin).toBe("full");
    expect(INBOUND_DISPOSITION.cancelDeviceLogin).toBe("full");
    expect(INBOUND_DISPOSITION.recheckConnection).toBe("host-local");
    expect(INBOUND_DISPOSITION.retryProviderSession).toBe("propose");
    expect(INBOUND_DISPOSITION.clearAllSessions).toBe("full");
    expect(INBOUND_DISPOSITION.remotePreferences).toBe("view");
    expect(INBOUND_DISPOSITION.listSessions).toBe("view");
    expect(INBOUND_DISPOSITION.selectRepo).toBe("view");
    expect(INBOUND_DISPOSITION.toggleRepoPin).toBe("full");
    expect(INBOUND_DISPOSITION.setRepoColor).toBe("full");
    // native pickers/editors/mic act on the LOCAL VS Code — never remote-drivable
    expect(INBOUND_DISPOSITION.openFile).toBe("host-local");
    expect(INBOUND_DISPOSITION.showInFolder).toBe("host-local");
    expect(INBOUND_DISPOSITION.openText).toBe("host-local");
    expect(INBOUND_DISPOSITION.pickFile).toBe("host-local");
    expect(INBOUND_DISPOSITION.voiceStart).toBe("host-local");
    expect(INBOUND_DISPOSITION.remoteVoiceStart).toBe("propose");
    expect(INBOUND_DISPOSITION.remoteVoiceChunk).toBe("propose");
    expect(INBOUND_DISPOSITION.remoteVoiceStop).toBe("propose");
    expect(INBOUND_DISPOSITION.moveView).toBe("host-local");
    // config writers mutate the HOST user's settings — blocked until a
    // per-connection view pref exists
    expect(INBOUND_DISPOSITION.setShowThinking).toBe("host-local");
    expect(INBOUND_DISPOSITION.setReadRepliesAloud).toBe("host-local");
    expect(INBOUND_DISPOSITION.setSummarizeRepliesAloud).toBe("host-local");
    expect(INBOUND_DISPOSITION.setVoiceSendPhrase).toBe("propose");
    expect(INBOUND_DISPOSITION.setVoiceKeyterms).toBe("propose");
    expect(INBOUND_DISPOSITION.setTelemetryEnabled).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.telemetryEnabled).toBe("mirror");
    expect(INBOUND_DISPOSITION.setThumbsFeedback).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.thumbsFeedback).toBe("mirror");
    expect(INBOUND_DISPOSITION.summarizeSpeech).toBe("propose");
    expect(INBOUND_DISPOSITION.requestImageFull).toBe("propose");
    // Worktree create/apply/remove stay host-local. apply/remove now refuse a
    // mismatched sessionId and act on the dispatch session, but widening back
    // to "propose" is a separate product decision — see remote-policy.ts.
    expect(INBOUND_DISPOSITION.newWorktreeSession).toBe("host-local");
    expect(INBOUND_DISPOSITION.applyWorktree).toBe("host-local");
    expect(INBOUND_DISPOSITION.removeWorktree).toBe("host-local");
    // Rewind, edit-and-resend and the confirm that gates them are reachable
    // from a remote since 2026-09-01. The three move together on purpose: an
    // admitted rewind whose confirm is refused would hang forever, since
    // confirmInChat resolves only on an answer.
    expect(INBOUND_DISPOSITION.rewindSession).toBe("propose");
    expect(INBOUND_DISPOSITION.editLastMessage).toBe("propose");
    expect(INBOUND_DISPOSITION.uiConfirmAnswer).toBe("propose");
    // relay account actions manage THIS machine's device token
    expect(INBOUND_DISPOSITION.remoteSignIn).toBe("host-local");
    expect(INBOUND_DISPOSITION.remoteSignOut).toBe("host-local");
    expect(INBOUND_DISPOSITION.unlinkRemoteDevice).toBe("host-local");
    expect(INBOUND_DISPOSITION.openRemotePortal).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.remoteStatus).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.readRepliesAloud).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.summarizeRepliesAloud).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.speechSummary).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.providerState).toBe("mirror");
    expect(INBOUND_DISPOSITION.installCodex).toBe("host-local");
    // Local call sites stay local-only; the same output shapes carry remote STT.
    expect(OUTBOUND_DISPOSITION.voiceState).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.voiceConfigured).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.media).toBe("media");
    expect(OUTBOUND_DISPOSITION.messageChunk).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.permissionRequest).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.permissionOptions).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.feedbackAvailability).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.turnFeedbackAck).toBe("mirror");
  });
});

describe("remote repo target gate", () => {
  // A predicate, not a set: the host resolves the catalog from disk, and this
  // gate runs on every inbound message including per-keystroke mentionQuery.
  const known = new Set(["/work/a", "/work/b"]);
  const discovered = (cwd: string) => known.has(cwd);

  it("is consulted lazily — a message with no cwd never resolves the catalog", () => {
    let calls = 0;
    const counting = (cwd: string) => { calls++; return known.has(cwd); };
    expect(allowRemoteRepoTarget({ type: "send", text: "hi" }, counting)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "mentionQuery", query: "a" }, counting)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s" }, counting)).toBe(true);
    expect(calls).toBe(0);
  });

  it("accepts only discovered cwd values for switching, pinning, and explicit resume", () => {
    expect(allowRemoteRepoTarget({ type: "selectRepo", cwd: "/work/a" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "toggleRepoPin", cwd: "/work/b", pinned: true }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "setRepoColor", cwd: "/work/a", color: "blue" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s", cwd: "/work/a" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "clearAllSessions", cwd: "/work/a" }, discovered)).toBe(true);
    // The rail previews a repo without selecting it — same catalog gate, so it
    // cannot become a way to read history for a path the host never published.
    expect(allowRemoteRepoTarget({ type: "listRepoSessions", cwd: "/work/a" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "listRepoSessions", cwd: "/etc" }, discovered)).toBe(false);
    // File browse names a cwd — without listing these types here, the default
    // branch would return true and a remote could claim an arbitrary path.
    expect(allowRemoteRepoTarget({ type: "listProjectDir", cwd: "/work/a" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "listProjectDir", cwd: "/etc" }, discovered)).toBe(false);
    expect(allowRemoteRepoTarget({ type: "readProjectFile", cwd: "/work/a", relPath: "a.ts" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "readProjectFile", cwd: "/etc", relPath: "passwd" }, discovered)).toBe(false);
    expect(
      allowRemoteRepoTarget(
        {
          type: "writeProjectFile",
          cwd: "/work/a",
          relPath: "a.ts",
          text: "x",
          stamp: { mtimeMs: 1, size: 1 },
          expectedAbsPath: "/work/a/a.ts",
        },
        discovered,
      ),
    ).toBe(true);
    expect(
      allowRemoteRepoTarget(
        {
          type: "writeProjectFile",
          cwd: "/etc",
          relPath: "passwd",
          text: "x",
          stamp: { mtimeMs: 1, size: 1 },
          expectedAbsPath: "/etc/passwd",
        },
        discovered,
      ),
    ).toBe(false);
    expect(allowRemoteRepoTarget({ type: "selectRepo", cwd: "/etc" }, discovered)).toBe(false);
    expect(allowRemoteRepoTarget({ type: "toggleRepoPin", cwd: "/etc", pinned: true }, discovered)).toBe(false);
    // A colour write that names an arbitrary cwd is the same hole as archive/pin.
    expect(allowRemoteRepoTarget({ type: "setRepoColor", cwd: "/etc", color: "teal" }, discovered)).toBe(false);
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s", cwd: "/etc" }, discovered)).toBe(false);
    expect(allowRemoteRepoTarget({ type: "clearAllSessions", cwd: "/etc" }, discovered)).toBe(false);
  });

  it("allows cwd-less resume to use the host's already-bounded resolution", () => {
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "send", text: "hi" }, discovered)).toBe(true);
  });

  it("allows cwd-less toggleSessionPin at the wire gate (host re-checks home)", () => {
    // Protocol keeps cwd optional; authorization of the resolved home is host-side.
    expect(
      allowRemoteRepoTarget({ type: "toggleSessionPin", id: "s", pinned: true }, discovered),
    ).toBe(true);
    expect(
      allowRemoteRepoTarget(
        { type: "toggleSessionPin", id: "s", cwd: "/etc", pinned: true },
        discovered,
      ),
    ).toBe(false);
  });
});

describe("mayDeliverRemoteHostMsg (outbound project authorization)", () => {
  const open = ["/work/open"];
  const closed = "/work/closed";
  const same = pathsEqual;

  it("always allows device prefs, errors, and path-free chrome", () => {
    expect(
      mayDeliverRemoteHostMsg({ type: "error", text: "x" }, open, closed, same),
    ).toBe(true);
    expect(
      mayDeliverRemoteHostMsg({ type: "showThinking", value: true }, open, undefined, same),
    ).toBe(true);
    expect(
      mayDeliverRemoteHostMsg({ type: "clearMessages" }, open, undefined, same),
    ).toBe(true);
  });

  it("delivers the file-browser answers for an authorized project", () => {
    // All three were classified `message-cwd` and then not handled in that
    // branch, so every one fell through to false. The remote file browser sent
    // its request, the host answered, and the answer was dropped here — the
    // panel sat on "Loading…" for ever and the feature had never worked.
    expect(
      mayDeliverRemoteHostMsg(
        { type: "projectDirListing", cwd: open[0], relPath: "", ok: true, entries: [], truncated: false },
        open,
        undefined,
        same,
      ),
    ).toBe(true);
    expect(
      mayDeliverRemoteHostMsg(
        { type: "projectFileContent", cwd: open[0], relPath: "a.md", ok: false, reason: "nope" },
        open,
        undefined,
        same,
      ),
    ).toBe(true);
    expect(
      mayDeliverRemoteHostMsg(
        { type: "projectFileWriteResult", cwd: open[0], relPath: "a.md", ok: true, stamp: { mtimeMs: 1, size: 2 } },
        open,
        undefined,
        same,
      ),
    ).toBe(true);
  });

  it("filters an unauthorized repoSessions row instead of dropping authorized rows", () => {
    const mixed = {
      type: "repoSessions",
      cwd: open[0],
      entries: [
        { id: "ordinary", cwd: open[0], title: "Ordinary" },
        { id: "worktree", cwd: "/tmp/worktree", title: "Worktree" },
      ],
      dots: { ordinary: "working", worktree: "needs-you" },
      total: 2,
    } as Extract<HostMsg, { type: "repoSessions" }>;

    // The raw mixed frame still fails closed; the outbound rewriter makes the
    // authorized subset pass the same gate.
    expect(mayDeliverRemoteHostMsg(mixed, open, undefined, same)).toBe(false);
    const filtered = repoSessionsMessageForRemote(mixed, open, same);
    expect(filtered.entries.map((entry) => entry.id)).toEqual(["ordinary"]);
    expect(filtered.dots).toEqual({ ordinary: "working" });
    expect(filtered.total).toBe(1);
    expect(mayDeliverRemoteHostMsg(filtered, open, undefined, same)).toBe(true);
  });

  it("allows a coarse empty repoSessions refusal to answer an unauthorized request", () => {
    expect(mayDeliverRemoteHostMsg({
      type: "repoSessions",
      cwd: closed,
      entries: [],
      dots: {},
      total: 0,
      error: "project-unavailable",
    }, open, undefined, same)).toBe(true);
  });

  describe("the routines frame", () => {
    // Same class of bug as the `message-cwd` one above, mirrored: `entries` was
    // hardcoded to sessions/pinnedSessions and returned [] for anything else,
    // so a newly-classified type would `.every()` over nothing and pass. That
    // fails OPEN rather than closed, which is the worse direction.
    const routine = (cwd: string) => ({
      id: "r1", title: "Brief", prompt: "p", cwd,
      provider: "grok" as const, model: "grok-4.6",
      cadence: { every: 6, unit: "hours" as const },
      createdAt: 0, cadenceLabel: "Every 6 hours", nextRunAt: 0,
      runs: [], health: { ran: 0, skipped: 0, failed: 0, total: 0 },
      projectLabel: "open",
    });
    const frame = (entries: ReturnType<typeof routine>[], projects: { cwd: string; label: string }[]) =>
      ({ type: "routines", entries, projects, models: [] }) as never;

    it("delivers routines for an authorized project", () => {
      expect(
        mayDeliverRemoteHostMsg(frame([routine(open[0])], [{ cwd: open[0], label: "open" }]), open, undefined, same),
      ).toBe(true);
    });

    it("refuses a routine that names a project this tab may not reach", () => {
      expect(
        mayDeliverRemoteHostMsg(frame([routine(closed)], [{ cwd: open[0], label: "open" }]), open, undefined, same),
      ).toBe(false);
    });

    it("refuses when only the PICKER names an unreachable project", () => {
      // The rows are all fine here. Checking `entries` alone would pass this
      // and hand the phone the name of every project on the machine through
      // the dropdown — which is a leak with no row attached to it.
      expect(
        mayDeliverRemoteHostMsg(
          frame([routine(open[0])], [{ cwd: open[0], label: "open" }, { cwd: closed, label: "secret" }]),
          open,
          undefined,
          same,
        ),
      ).toBe(false);
    });

    it("refuses a routine carrying no cwd at all", () => {
      // Unlike the session lists, an empty cwd is not a legitimate state here:
      // every routine has a project by construction, so a blank one is
      // malformed and must not be treated as "nothing to check".
      expect(
        mayDeliverRemoteHostMsg(frame([routine("")], []), open, undefined, same),
      ).toBe(false);
    });

    it("delivers an empty page", () => {
      expect(mayDeliverRemoteHostMsg(frame([], []), open, undefined, same)).toBe(true);
    });

    describe("routinesMessageForRemote", () => {
      it("drops what a connection may not reach instead of dropping the page", () => {
        const full = frame(
          [routine(open[0]), routine(closed)],
          [{ cwd: open[0], label: "open" }, { cwd: closed, label: "removed" }],
        ) as Extract<HostMsg, { type: "routines" }>;

        expect(mayDeliverRemoteHostMsg(full, open, undefined, same)).toBe(false);

        const trimmed = routinesMessageForRemote(full, open, same);
        expect(trimmed.entries.map((e) => e.cwd)).toEqual([open[0]]);
        expect(trimmed.projects.map((p) => p.cwd)).toEqual([open[0]]);
        // And what comes out always survives the gate, so the check stays a
        // backstop rather than an outage.
        expect(mayDeliverRemoteHostMsg(trimmed, open, undefined, same)).toBe(true);
      });

      it("leaves an already-authorized frame alone", () => {
        const clean = frame([routine(open[0])], [{ cwd: open[0], label: "open" }]) as Extract<
          HostMsg,
          { type: "routines" }
        >;
        const trimmed = routinesMessageForRemote(clean, open, same);
        expect(trimmed.entries).toHaveLength(1);
        expect(trimmed.projects).toHaveLength(1);
        expect(trimmed.models).toEqual(clean.models);
      });

      // Repoint a routine from A to B, then remove A. The entry now passes
      // under B while a RETAINED run still names A — so the routine's own cwd
      // does not vouch for its history, and filtering only the top level sends
      // a revoked project's path and session id across the wire.
      const withRun = (routineCwd: string, runCwd: string) => {
        const base = routine(routineCwd);
        return {
          ...base,
          runs: [
            {
              routineId: "r1", windowKey: "i0", startedAt: 1, outcome: "ran" as const,
              sessionId: "s-1", cwd: runCwd, detail: `wrote ${runCwd}/notes.md`,
            },
          ],
        };
      };

      it("redacts a run whose own project is out of reach", () => {
        const full = frame(
          [withRun(open[0], closed)],
          [{ cwd: open[0], label: "open" }],
        ) as Extract<HostMsg, { type: "routines" }>;

        // The top-level filter alone would pass this straight through.
        expect(mayDeliverRemoteHostMsg(full, open, undefined, same)).toBe(false);

        const trimmed = routinesMessageForRemote(full, open, same);
        const [run] = trimmed.entries[0].runs;
        // The run survives — it happened, and the health count beside it is
        // computed host-side from the full list.
        expect(trimmed.entries[0].runs).toHaveLength(1);
        expect(run.outcome).toBe("ran");
        expect(run.startedAt).toBe(1);
        // Its identity does not. Path, session and the detail that could quote
        // either are all gone, so the tick is simply unclickable.
        expect(run.cwd).toBeUndefined();
        expect(run.sessionId).toBeUndefined();
        expect(run.detail).toBeUndefined();
        expect(JSON.stringify(trimmed)).not.toContain(closed);

        expect(mayDeliverRemoteHostMsg(trimmed, open, undefined, same)).toBe(true);
      });

      it("leaves a run in a reachable project completely alone", () => {
        const full = frame(
          [withRun(open[0], open[0])],
          [{ cwd: open[0], label: "open" }],
        ) as Extract<HostMsg, { type: "routines" }>;
        const [run] = routinesMessageForRemote(full, open, same).entries[0].runs;
        expect(run.cwd).toBe(open[0]);
        expect(run.sessionId).toBe("s-1");
        expect(run.detail).toBeTruthy();
      });

      it("passes a run recorded before runs carried a project", () => {
        // No cwd means the session resolves against the routine's current
        // project, which is already checked — so there is nothing to redact.
        const legacy = routine(open[0]) as ReturnType<typeof routine> & { runs: unknown[] };
        legacy.runs = [{ routineId: "r1", windowKey: "i0", startedAt: 1, outcome: "ran", sessionId: "s-1" }];
        const full = frame([legacy], [{ cwd: open[0], label: "open" }]) as Extract<
          HostMsg,
          { type: "routines" }
        >;
        expect(mayDeliverRemoteHostMsg(full, open, undefined, same)).toBe(true);
        expect(routinesMessageForRemote(full, open, same).entries[0].runs[0].sessionId).toBe("s-1");
      });

      it("yields an empty page rather than nothing when NOTHING is reachable", () => {
        const none = frame([routine(closed)], [{ cwd: closed, label: "removed" }]) as Extract<
          HostMsg,
          { type: "routines" }
        >;
        const trimmed = routinesMessageForRemote(none, open, same);
        expect(trimmed.entries).toEqual([]);
        expect(trimmed.projects).toEqual([]);
        // An empty page says "no routines here"; a dropped frame says nothing
        // at all and leaves the phone on a spinner.
        expect(mayDeliverRemoteHostMsg(trimmed, open, undefined, same)).toBe(true);
      });
    });
  });

  it("still refuses a file-browser answer for a project that has since closed", () => {
    // The whole point of classifying them `message-cwd`: the request was let in
    // while the project was open, and the answer must be re-checked against the
    // LIVE set rather than trusted from when it was accepted.
    for (const msg of [
      { type: "projectDirListing", cwd: closed, relPath: "", ok: true, entries: [], truncated: false },
      { type: "projectFileContent", cwd: closed, relPath: "a.md", ok: true, kind: "text", text: "x" },
      { type: "projectFileWriteResult", cwd: closed, relPath: "a.md", ok: true, stamp: { mtimeMs: 1, size: 2 } },
    ] as const) {
      expect(mayDeliverRemoteHostMsg(msg as never, open, closed, same), msg.type).toBe(false);
    }
  });

  it("refuses repos / initialState frames that carry a closed project's cwd", () => {
    // Unconditional "none" classification was the hole: builders could (and
    // rehome deliberately did) put a closed selectedCwd on the wire.
    expect(
      mayDeliverRemoteHostMsg(
        { type: "repos", entries: [], selectedCwd: closed, activeCwd: closed },
        open,
        closed,
        same,
      ),
    ).toBe(false);
    expect(
      mayDeliverRemoteHostMsg(
        { type: "repos", entries: [], selectedCwd: closed, activeCwd: "/work/open" },
        open,
        closed,
        same,
      ),
    ).toBe(false);
    expect(
      mayDeliverRemoteHostMsg(
        {
          type: "repos",
          entries: [
            {
              cwd: closed,
              label: "leak",
              available: true,
              pinned: false,
              updatedAt: 1,
            },
          ],
          selectedCwd: "/work/open",
          activeCwd: "/work/open",
        },
        open,
        "/work/open",
        same,
      ),
    ).toBe(false);

    // Empty selected/active after rehome (unbound) is OK — not a closed path.
    expect(
      mayDeliverRemoteHostMsg(
        { type: "repos", entries: [], selectedCwd: "", activeCwd: "" },
        open,
        undefined,
        same,
      ),
    ).toBe(true);
    expect(
      mayDeliverRemoteHostMsg(
        {
          type: "repos",
          entries: [
            {
              cwd: "/work/open",
              label: "open",
              available: true,
              pinned: false,
              updatedAt: 1,
            },
          ],
          selectedCwd: "/work/open",
          activeCwd: "/work/open",
        },
        open,
        "/work/open",
        same,
      ),
    ).toBe(true);

    const caps = {
      uploadFile: true,
      remoteVoice: true,
      deleteActiveSession: true,
    };
    const baseInitial = {
      type: "initialState" as const,
      effort: "",
      useCtrlEnter: false,
      extVersion: "0",
      showThinking: false,
      expandCommandOutputs: false,
      steerByDefault: false,
      soundNotifications: false,
      processingSound: false,
      readRepliesAloud: false,
      capabilities: caps,
    };
    expect(
      mayDeliverRemoteHostMsg({ ...baseInitial, cwd: closed }, open, closed, same),
    ).toBe(false);
    expect(
      mayDeliverRemoteHostMsg({ ...baseInitial, cwd: "/work/open" }, open, closed, same),
    ).toBe(true);
    expect(
      mayDeliverRemoteHostMsg({ ...baseInitial, cwd: "" }, open, undefined, same),
    ).toBe(true);
  });

  it("classifies repos as repos-catalog and initialState as optional-cwd", () => {
    expect(OUTBOUND_PROJECT_AUTH.repos).toBe("repos-catalog");
    expect(OUTBOUND_PROJECT_AUTH.initialState).toBe("optional-cwd");
    expect(OUTBOUND_PROJECT_AUTH.initialized).toBe("scope");
    // Project voice prefs (sendPhrase / key resolution) must not follow a closed tab.
    expect(OUTBOUND_PROJECT_AUTH.voiceConfigured).toBe("scope");
    expect(OUTBOUND_PROJECT_AUTH.voiceState).toBe("none");
    expect(OUTBOUND_PROJECT_AUTH.clearMessages).toBe("none");
    expect(OUTBOUND_PROJECT_AUTH.error).toBe("none");
  });

  it("refuses voiceConfigured for a closed or missing project scope", () => {
    const msg: HostMsg = {
      type: "voiceConfigured",
      value: true,
      sendPhrase: "grok send",
    };
    // Prior project closed / re-homed — must not keep delivering its prefs.
    expect(mayDeliverRemoteHostMsg(msg, open, closed, same)).toBe(false);
    expect(mayDeliverRemoteHostMsg(msg, open, undefined, same)).toBe(false);
    // Authorized open scope still delivers.
    expect(mayDeliverRemoteHostMsg(msg, open, "/work/open", same)).toBe(true);
  });

  it("mutation: voiceConfigured classified as none reopens the cross-project prefs leak", () => {
    // If OUTBOUND_PROJECT_AUTH.voiceConfigured were "none", mayDeliver would
    // always return true and a closed-tab client would keep the prior project's
    // sendPhrase / configured flag. Classification must be "scope".
    expect(OUTBOUND_PROJECT_AUTH.voiceConfigured).not.toBe("none");
    expect(OUTBOUND_PROJECT_AUTH.voiceConfigured).toBe("scope");
    const msg: HostMsg = { type: "voiceConfigured", value: true };
    // Gate with closed scope must refuse (fails if classification is none).
    expect(mayDeliverRemoteHostMsg(msg, open, closed, same)).toBe(false);
  });

  it("mutation: treating repos as unconditional none reopens the closed-cwd leak", () => {
    // If classification falls back to always-true, a closed selectedCwd leaves.
    const msg: HostMsg = {
      type: "repos",
      entries: [],
      selectedCwd: closed,
      activeCwd: closed,
    };
    const buggyNoneAlways = true;
    expect(buggyNoneAlways).toBe(true);
    expect(mayDeliverRemoteHostMsg(msg, open, closed, same)).toBe(false);
  });

  it("refuses transcript / history content without an authorized scope cwd", () => {
    const chunk: HostMsg = { type: "messageChunk", text: "secret from closed project" };
    expect(mayDeliverRemoteHostMsg(chunk, open, closed, same)).toBe(false);
    expect(mayDeliverRemoteHostMsg(chunk, open, undefined, same)).toBe(false);
    expect(mayDeliverRemoteHostMsg(chunk, open, "/work/open", same)).toBe(true);
  });

  it("refuses historyBatch that would carry closed-project transcript", () => {
    const batch: HostMsg = {
      type: "historyBatch",
      messages: [
        { type: "userMessage", text: "hi" },
        { type: "messageChunk", text: "leak" },
      ],
    };
    expect(mayDeliverRemoteHostMsg(batch, open, closed, same)).toBe(false);
    expect(mayDeliverRemoteHostMsg(batch, open, "/work/open", same)).toBe(true);
  });

  it("refuses sessionName / chips / sessionDot for a closed scope", () => {
    expect(
      mayDeliverRemoteHostMsg(
        { type: "sessionName", sessionId: "s", name: "X", cwd: closed },
        open,
        closed,
        same,
      ),
    ).toBe(false);
    expect(
      mayDeliverRemoteHostMsg({ type: "chips", chips: [] }, open, closed, same),
    ).toBe(false);
    expect(
      mayDeliverRemoteHostMsg({ type: "sessionDot", id: "s", dot: "none" }, open, closed, same),
    ).toBe(false);
    expect(
      mayDeliverRemoteHostMsg({ type: "sessionDot", id: "s", dot: "working" }, open, "/work/open", same),
    ).toBe(true);
  });

  it("allows empty sessions lists and refuses lists that include a closed cwd entry", () => {
    expect(
      mayDeliverRemoteHostMsg(
        {
          type: "sessions",
          entries: [],
          activeId: null,
          dots: {},
          offset: 0,
          total: 0,
          hasMore: false,
          nextOffset: 0,
          query: "",
        },
        open,
        closed,
        same,
      ),
    ).toBe(true);
    expect(
      mayDeliverRemoteHostMsg(
        {
          type: "sessions",
          entries: [
            {
              id: "a",
              cwd: closed,
              displayName: "leak",
              rawSummary: "",
              updatedAt: 1,
              createdAt: 1,
              numMessages: 0,
            },
          ],
          activeId: null,
          dots: {},
          offset: 0,
          total: 1,
          hasMore: false,
          nextOffset: 1,
          query: "",
        },
        open,
        closed,
        same,
      ),
    ).toBe(false);
  });

  it("mutation: trusting mapping-clear order alone would re-open the transcript leak", () => {
    // Old path: sendRemoteHistorySnapshot only checked clientsForActiveValue.
    // If revoke ordered mapping clear after a concurrent snapshot, transcript
    // still left. Fixed path: mayDeliverRemoteHostMsg refuses closed scope.
    const snapshotMsg: HostMsg = { type: "userMessage", text: "from closed" };
    const clientStillMapped = true; // simulated race
    const oldWouldSend = clientStillMapped;
    expect(oldWouldSend).toBe(true);
    expect(mayDeliverRemoteHostMsg(snapshotMsg, open, closed, same)).toBe(false);
  });
});

describe("allowFromRemote tier gating", () => {
  it("view ops pass at every tier", () => {
    for (const tier of ["read-only", "propose", "full"] as const) {
      expect(allowFromRemote("listSessions", tier)).toBe(true);
      expect(allowFromRemote("listRepoSessions", tier)).toBe(true);
      expect(allowFromRemote("resumeSession", tier)).toBe(true);
      expect(allowFromRemote("remotePreferences", tier)).toBe(true);
    }
  });

  it("propose ops need propose or full", () => {
    expect(allowFromRemote("send", "read-only")).toBe(false);
    expect(allowFromRemote("send", "propose")).toBe(true);
    expect(allowFromRemote("send", "full")).toBe(true);
    expect(allowFromRemote("summarizeSpeech", "read-only")).toBe(false);
    expect(allowFromRemote("summarizeSpeech", "propose")).toBe(true);
  });

  it("approvals and destructive session ops need full", () => {
    for (const t of ["permissionAnswer", "exitPlanAnswer", "deleteSession", "clearAllSessions"] as const) {
      expect(allowFromRemote(t, "propose")).toBe(false);
      expect(allowFromRemote(t, "full")).toBe(true);
    }
  });

  it("allows connector changes at full and mirrors capability plus targeted OAuth frames without project scope", () => {
    expect(INBOUND_DISPOSITION.connectMcpConnector).toBe("full");
    expect(INBOUND_DISPOSITION.disconnectMcpConnector).toBe("full");
    expect(INBOUND_DISPOSITION.completeMcpConnectorOAuth).toBe("full");
    expect(OUTBOUND_DISPOSITION.mcpConnectorAuthorization).toBe("mirror");
    expect(OUTBOUND_PROJECT_AUTH.mcpConnectorAuthorization).toBe("none");
    const frame: HostMsg = { type: "mcpConnectorAuthorization", id: "notion", attemptId: "attempt-1", status: "waiting", url: "https://vendor.example/authorize" };
    expect(mayDeliverRemoteHostMsg(frame, [], undefined, pathsEqual)).toBe(true);
    expect(transformHostMsgForRemote(frame)).toEqual(frame);
    expect(transformHostMsgForRemote({ type: "mcpConnectors", connectors: [], remoteConnect: true }))
      .toEqual({ type: "mcpConnectors", connectors: [], remoteConnect: true });
    expect(OUTBOUND_DISPOSITION.mcpConnectors).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.mcpServers).toBe("allowlist");
    expect(OUTBOUND_PROJECT_AUTH.mcpServers).toBe(OUTBOUND_PROJECT_AUTH.mcpConnectors);
    expect(INBOUND_DISPOSITION.listMcpServers).toBe("view");
    expect(allowFromRemote("listMcpServers", "read-only")).toBe(true);
    expect(allowFromRemote("listMcpServers", "propose")).toBe(true);
    expect(allowFromRemote("listMcpServers", "full")).toBe(true);
    for (const type of ["connectMcpConnector", "disconnectMcpConnector", "completeMcpConnectorOAuth"] as const) {
      for (const tier of ["read-only", "propose", "full"] as const) {
        expect(allowFromRemote(type, tier)).toBe(tier === "full");
      }
    }
  });

  it("a remote may write or clear a connector key at full", () => {
    for (const type of ["connectMcpConnector", "disconnectMcpConnector"] as const) {
      expect(allowFromRemote(type, "full")).toBe(true);
    }
  });

  it("refuses a remote-origin provider logout at every tier", () => {
    // `runGrokLogin` used to be tested alongside this one and no longer belongs
    // here: a remote may now START a sign-in (see below). Signing out is the
    // half that stays refused, because it revokes a credential every other
    // surface is using.
    expect(INBOUND_DISPOSITION.logout).toBe("host-local");
    for (const tier of ["read-only", "propose", "full"] as const) {
      expect(allowFromRemote("logout", tier)).toBe(false);
    }
  });

  it("lets a remote start a sign-in, but only at full", () => {
    expect(allowFromRemote("runGrokLogin", "full")).toBe(true);
    expect(allowFromRemote("cancelDeviceLogin", "full")).toBe(true);
    expect(allowFromRemote("submitDeviceLoginCode", "full")).toBe(true);
    expect(INBOUND_DISPOSITION.submitDeviceLoginCode).toBe("full");
    expect(allowFromRemote("setupGithubCli", "full")).toBe(true);
    expect(INBOUND_DISPOSITION.setupGithubCli).toBe("full");
    for (const tier of ["read-only", "propose"] as const) {
      expect(allowFromRemote("runGrokLogin", tier)).toBe(false);
      expect(allowFromRemote("cancelDeviceLogin", tier)).toBe(false);
      expect(allowFromRemote("submitDeviceLoginCode", tier)).toBe(false);
      expect(allowFromRemote("setupGithubCli", tier)).toBe(false);
    }
  });

  it("refuses a remote unlink of this machine at every tier", () => {
    expect(INBOUND_DISPOSITION.unlinkRemoteDevice).toBe("host-local");
    for (const tier of ["read-only", "propose", "full"] as const) {
      expect(allowFromRemote("unlinkRemoteDevice", tier)).toBe(false);
    }
  });

  it("a remote can never replace the CLI binary, at any tier", () => {
    // `updateGrok` / `checkGrokUpdate` used to sit in the list above, which
    // meant a phone could start a binary replacement on the desk machine. The
    // binaries live there and only the desk can replace them, so they are
    // host-local now — and the remote Version & about page is informational for
    // the same reason. The STATUS still travels: grokUpdateStatus is mirrored,
    // so a phone can see the CLI is behind without being able to act on it.
    for (const t of ["updateGrok", "checkGrokUpdate"] as const) {
      expect(allowFromRemote(t, "propose")).toBe(false);
      expect(allowFromRemote(t, "full")).toBe(false);
    }
  });

  it("host-local and control are never routed, even at full", () => {
    for (const t of ["openFile", "showInFolder", "pickFile", "voiceStart", "moveView", "dropFile", "exportExpr", "ready"] as const) {
      expect(allowFromRemote(t, "full")).toBe(false);
    }
  });
});

const deps = (bytes: Uint8Array | null): MediaInlineDeps => ({
  readFile: () => bytes,
  toBase64: (b) => Buffer.from(b).toString("base64"),
});

const mediaMsg = (over: Partial<Extract<HostMsg, { type: "media" }>> = {}): Extract<HostMsg, { type: "media" }> => ({
  type: "media",
  media: "image",
  ...over,
});

describe("inlineMediaForRemote", () => {
  it("passes an already-inlined data: src through unchanged", () => {
    const msg = mediaMsg({ src: "data:image/png;base64,AAAA" });
    expect(inlineMediaForRemote(msg, deps(null))).toBe(msg);
  });

  it("passes a remote-url-only message through (the browser can load it)", () => {
    const msg = mediaMsg({ url: "https://example.com/x.png" });
    expect(inlineMediaForRemote(msg, deps(null))).toBe(msg);
  });

  it("inlines a webview-uri src from the file path, inferring mime", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = inlineMediaForRemote(
      mediaMsg({ src: "https://file%2B.vscode-resource.example/x.png", path: "C:\\media\\shot.png" }),
      deps(bytes),
    );
    expect(out?.src).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    expect(out?.mimeType).toBe("image/png");
    expect(out?.path).toBe("C:\\media\\shot.png"); // copy-path action survives
  });

  it("prefers the message's own mimeType over the extension guess", () => {
    const out = inlineMediaForRemote(
      mediaMsg({ src: "x", path: "/a/pic.bin", mimeType: "image/jpeg" }),
      deps(new Uint8Array([9])),
    );
    expect(out?.src?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("never transfers video to a remote — by media kind, mime, or extension", () => {
    const bytes = deps(new Uint8Array([1]));
    expect(inlineMediaForRemote(mediaMsg({ media: "video", src: "x", path: "/a/clip.mp4" }), bytes)).toBeNull();
    // even an already-inlined or url-only video is dropped
    expect(inlineMediaForRemote(mediaMsg({ media: "video", src: "data:video/mp4;base64,AAAA" }), bytes)).toBeNull();
    expect(inlineMediaForRemote(mediaMsg({ media: "video", url: "https://example.com/x.mp4" }), bytes)).toBeNull();
    // mis-tagged media field still caught by the mime belt
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/a/clip.mp4" }), bytes)).toBeNull();
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/a/clip.bin", mimeType: "video/webm" }), bytes)).toBeNull();
  });

  it("drops (null) when the file is unreadable, oversized, or pathless", () => {
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/gone.png" }), deps(null))).toBeNull();
    const big = { ...deps(new Uint8Array(10)), maxBytes: 5 };
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/big.png" }), big)).toBeNull();
    expect(inlineMediaForRemote(mediaMsg({ src: "vscode-webview://x" }), deps(new Uint8Array(1)))).toBeNull();
  });

  it("default size cap is the documented constant", () => {
    expect(MAX_REMOTE_MEDIA_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("transformHostMsgForRemote", () => {
  it("mirror types pass through by reference", () => {
    const msg: HostMsg = { type: "messageChunk", text: "hi" };
    expect(transformHostMsgForRemote(msg, deps(null))).toBe(msg);
  });

  it("reused remote voice output types are mirrored", () => {
    expect(transformHostMsgForRemote({ type: "voiceState", status: "idle" }, deps(null)))
      .toEqual({ type: "voiceState", status: "idle" });
    expect(transformHostMsgForRemote({ type: "voiceConfigured", value: true }, deps(null)))
      .toEqual({ type: "voiceConfigured", value: true });
  });

  it("projects the Grok MCP inventory so launch recipes cannot reach a remote", () => {
    const bearer = "Authorization: Bearer sk_live_repro_token";
    const token = "sk_live_repro_token";
    const exe = "C:/Users/Alice/AppData/Roaming/npm/npx.cmd";
    const url = `https://mcp.linear.app/mcp?api_key=${token}`;
    const desk: HostMsg = {
      type: "mcpServers",
      servers: [{
        name: "linear",
        displayName: "Linear",
        enabled: true,
        source: "local",
        type: "stdio",
        status: "unavailable",
        command: exe,
        args: ["-y", "mcp-remote", url, "--header", bearer],
        url,
        error: `spawn EACCES ${exe} --header ${bearer}`,
        tools: [{
          name: "list_issues",
          description: "List issues",
          inputSchema: { properties: { token: { default: token } } },
        }],
        toolCount: 1,
      }],
      warning: "This list is read-only.",
    };
    const deskWire = JSON.stringify(desk);
    expect(deskWire).toContain(bearer);
    expect(deskWire).toContain(url);
    expect(deskWire).toContain("C:/Users/Alice");

    const out = transformHostMsgForRemote(desk, deps(null));
    expect(out).not.toBe(desk);
    expect(JSON.stringify(desk)).toBe(deskWire);
    expect(desk.servers[0].command).toBe(exe);

    const wire = JSON.stringify(out);
    expect(wire).not.toContain(bearer);
    expect(wire).not.toContain(token);
    expect(wire).not.toContain("C:/Users/Alice");
    expect(wire).not.toContain("Authorization");
    expect(wire).not.toContain(exe);
    expect(wire).not.toContain(url);
    expect(out).toEqual({
      type: "mcpServers",
      servers: [{
        name: "linear",
        displayName: "Linear",
        enabled: true,
        source: "local",
        type: "stdio",
        status: "unavailable",
        toolCount: 1,
      }],
      warning: "This list is read-only.",
    });
    expect(transformHostMsgForRemote(out!, deps(null))).toEqual(out);
  });

  it("mirrors mcpConnectors without a key field or PAT", () => {
    const planted = "ghp_TESTSECRET_do_not_store";
    const msg: HostMsg = {
      type: "mcpConnectors",
      connectors: connectorViews(
        { github: { endpoint: "https://api.githubcopilot.com/mcp/" } },
        { keySet: new Set(["github"]) },
      ),
    };
    const out = transformHostMsgForRemote(msg, deps(null));
    expect(out).toBe(msg);
    const json = JSON.stringify(out);
    expect(json).not.toContain(planted);
    expect(json).not.toMatch(/"key":|"token":|"authorization":/);
    const github = msg.connectors.find((c) => c.id === "github");
    expect(github).toMatchObject({ auth: "key", keySet: true, connected: true });
    expect(github).not.toHaveProperty("key");
    expect(github).not.toHaveProperty("token");

    const missingKey: HostMsg = {
      type: "mcpConnectors",
      connectors: connectorViews(
        { github: { endpoint: "https://api.githubcopilot.com/mcp/" } },
        { keySet: new Set() },
      ),
    };
    const missingOut = transformHostMsgForRemote(missingKey, deps(null));
    expect(missingOut).toBe(missingKey);
    const missingJson = JSON.stringify(missingOut);
    expect(missingJson).not.toContain(planted);
    expect(missingJson).not.toMatch(/"key":|"token":|"authorization":/);
    const missingGithub = missingKey.connectors.find((c) => c.id === "github");
    expect(missingGithub).toMatchObject({ auth: "key", keySet: false, connected: true });
    expect(missingGithub).not.toHaveProperty("key");
    expect(missingGithub).not.toHaveProperty("token");
  });

  it("leaves a safe MCP inventory row intact on the remote projection", () => {
    const msg: HostMsg = {
      type: "mcpServers",
      servers: [{ name: "managed_gateway:canva", displayName: "Canva", enabled: true, status: "ready", managed: true, toolCount: 32 }],
      warning: "This list is read-only.",
    };
    expect(transformHostMsgForRemote(msg, deps(null))).toEqual(msg);
    expect(transformHostMsgForRemote(msg, deps(null))).not.toBe(msg);
  });

  it("media is inlined via the injected reader", () => {
    const out = transformHostMsgForRemote(mediaMsg({ src: "x", path: "/img.webp" }), deps(new Uint8Array([7])));
    expect((out as { src?: string })?.src?.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("inlines image-chip previews while preserving the chip when the source is missing", () => {
    const chip = {
      id: "image-1",
      path: "/img.png",
      relPath: "Image #1",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    const out = transformHostMsgForRemote({ type: "chips", chips: [chip] }, deps(new Uint8Array([7]))) as Extract<HostMsg, { type: "chips" }>;
    expect(out.chips[0].previewSrc).toBe("data:image/png;base64,Bw==");

    const missing = transformHostMsgForRemote({ type: "chips", chips: [chip] }, deps(null)) as Extract<HostMsg, { type: "chips" }>;
    expect(missing.chips[0]).toEqual(chip);
    expect(missing.chips[0].previewSrc).toBeUndefined();

    const queued = transformHostMsgForRemote({
      type: "queuedSends",
      items: ["see this"],
      queued: [{ text: "see this", chips: [chip] }],
    }, deps(new Uint8Array([7]))) as Extract<HostMsg, { type: "queuedSends" }>;
    expect(queued.queued?.[0].chips?.[0].previewSrc).toBe("data:image/png;base64,Bw==");
  });

  it("uses the thumbnail hook and keeps replayed image tags usable remotely", () => {
    const imageDeps: MediaInlineDeps = {
      ...deps(new Uint8Array([1, 2, 3])),
      // The encoder picks a format per image, so the hook reports the mime of
      // what it produced — here a JPEG from a PNG source, which is exactly the
      // case a source-mime label would get wrong.
      thumbnail: () => ({ bytes: new Uint8Array([9]), mime: "image/jpeg" }),
    };
    const out = transformHostMsgForRemote({
      type: "userMessageChunk",
      text: "[Image #1] (C:\\staged\\image.png — attached inline; do not Read it)",
      images: [{ imageIndex: 1, path: "C:\\staged\\image.png" }],
    }, imageDeps) as Extract<HostMsg, { type: "userMessageChunk" }>;
    expect(out.images?.[0].previewSrc).toBe("data:image/jpeg;base64,CQ==");
    expect(MAX_REMOTE_THUMBNAIL_BYTES).toBe(96 * 1024);
  });

  it("issues an enlarge handle only where a thumbnail actually goes out", () => {
    // The handle is what a remote exchanges for a full-size render, so the set
    // of enlargeable images must equal the set already shown. Minting one for an
    // image we could not thumbnail would hand out reach the remote never had.
    const registered: string[] = [];
    const withHandles = (bytes: Uint8Array | null): MediaInlineDeps => ({
      readFile: () => bytes,
      toBase64: (b) => Buffer.from(b).toString("base64"),
      thumbnail: () => ({ bytes: new Uint8Array([9]), mime: "image/png" }),
      registerFullImage: (p) => {
        registered.push(p);
        return `handle-${registered.length}`;
      },
    });
    const chip = {
      id: "image-1",
      path: "/img.png",
      relPath: "Image #1",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };

    const shown = transformHostMsgForRemote(
      { type: "chips", chips: [chip] },
      withHandles(new Uint8Array([1, 2, 3])),
    ) as Extract<HostMsg, { type: "chips" }>;
    expect(shown.chips[0].fullId).toBe("handle-1");
    expect(registered).toEqual(["/img.png"]);

    // Unreadable source: no thumbnail crosses, so no handle may either.
    registered.length = 0;
    const hidden = transformHostMsgForRemote(
      { type: "chips", chips: [chip] },
      withHandles(null),
    ) as Extract<HostMsg, { type: "chips" }>;
    expect(hidden.chips[0].previewSrc).toBeUndefined();
    expect(hidden.chips[0].fullId).toBeUndefined();
    expect(registered).toEqual([]);
  });

  it("memoizes a thumbnail by source path and mtime across message shapes", () => {
    let reads = 0;
    let thumbnails = 0;
    const imageDeps: MediaInlineDeps = {
      readFile: () => {
        reads += 1;
        return new Uint8Array([1, 2, 3]);
      },
      toBase64: (bytes) => Buffer.from(bytes).toString("base64"),
      thumbnail: () => {
        thumbnails += 1;
        return { bytes: new Uint8Array([9]), mime: "image/png" };
      },
      mtimeMs: () => 42,
      thumbnailCache: new Map(),
    };
    const chip = {
      id: "image-1",
      path: "/img.png",
      relPath: "Image #1",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    transformHostMsgForRemote({ type: "chips", chips: [chip] }, imageDeps);
    const out = transformHostMsgForRemote({
      type: "userMessageChunk",
      text: "[Image #1] (img.png)",
      images: [{ imageIndex: 1, path: "/img.png" }],
    }, imageDeps) as Extract<HostMsg, { type: "userMessageChunk" }>;
    expect(out.images?.[0].previewSrc).toBe("data:image/png;base64,CQ==");
    expect(reads).toBe(1);
    expect(thumbnails).toBe(1);
  });
});

describe("mediaMimeFromPath", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(mediaMimeFromPath("/a/b.PNG")).toBe("image/png");
    expect(mediaMimeFromPath("clip.mp4")).toBe("video/mp4");
    expect(mediaMimeFromPath("noext")).toBe("application/octet-stream");
  });
});

describe("repo scope — global for remote, workspace-local in VS Code", () => {
  const WS = "/work/current";
  const PICKED = "/work/other";

  // The selection is global ON PURPOSE: that is the remote feature, one phone
  // driving whichever project you pick, with every remote client agreeing.
  it("gives every remote client the global selection", () => {
    expect(repoScopeFor("remote", { selectedCwd: PICKED, workspaceRoot: WS })).toBe(PICKED);
  });

  // ...but VS Code hides the switcher, so following the selection there is
  // strictly harmful: it would re-scope a history list the user cannot re-aim,
  // and point New session at a checkout they are not looking at — where Grok
  // would then write files.
  it("keeps VS Code on its own workspace no matter what a phone picked", () => {
    expect(repoScopeFor("local", { selectedCwd: PICKED, workspaceRoot: WS })).toBe(WS);
  });

  it("agrees on the workspace when nothing has been picked", () => {
    for (const origin of ["local", "remote"] as const) {
      expect(repoScopeFor(origin, { selectedCwd: "", workspaceRoot: WS })).toBe(WS);
    }
  });
});

describe("requesting session and repo boundary", () => {
  it("uses the remote group's active session for a remote destructive action", () => {
    const local = { id: "local" };
    const remote = { id: "remote" };
    expect(sessionForRequest("local", local, remote)).toBe(local);
    expect(sessionForRequest("remote", local, remote)).toBe(remote);
    expect(sessionForRequest("remote", local, undefined)).toBeUndefined();
  });

  it("accepts only session cwds owned by the selected repo group", () => {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    expect(sessionCwdBelongsToRepo("C:/Repo/B", ["c:/repo/b", "c:/repo/b-worktree"], same)).toBe(true);
    expect(sessionCwdBelongsToRepo("C:/Repo/A", ["c:/repo/b", "c:/repo/b-worktree"], same)).toBe(false);
  });

  it("adopts the desk session only for an arriving tab in the same repo", () => {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    expect(shouldAdoptDeskSession("C:/Repo/B", ["c:/repo/b"], false, same)).toBe(true);
    expect(shouldAdoptDeskSession("C:/Repo/A", ["c:/repo/b"], false, same)).toBe(false);
    expect(shouldAdoptDeskSession("C:/Repo/B", ["c:/repo/b"], true, same)).toBe(false);
  });
});

describe("remote reconnect snapshot replay", () => {
  const batched = (buffer: HostMsg[]) => {
    const snapshot = bracketRemoteSnapshot(buffer);
    expect(snapshot[0]).toEqual({ type: "historyReplay", active: true });
    expect(snapshot[2]).toEqual({ type: "historyReplay", active: false });
    expect(snapshot[1].type).toBe("historyBatch");
    return (snapshot[1] as Extract<HostMsg, { type: "historyBatch" }>).messages;
  };

  it("batches a below-limit transcript without changing its contents", () => {
    const buffer: HostMsg[] = [
      { type: "agentStart" },
      { type: "messageChunk", text: "already finished" },
      { type: "agentEnd" },
    ];
    expect(bracketRemoteSnapshot(buffer)).toEqual([
      { type: "historyReplay", active: true },
      { type: "historyBatch", messages: buffer },
      { type: "historyReplay", active: false },
    ]);
  });

  it("permits the targeted speech-summary result to cross remotely", () => {
    const msg: HostMsg = { type: "speechSummary", requestId: 7, text: "Brief update." };
    expect(transformHostMsgForRemote(msg, deps(null))).toBe(msg);
  });

  it("uses only the outer replay brackets when the buffered load had its own", () => {
    const messages = batched([
      { type: "historyReplay", active: true },
      { type: "userMessageChunk", text: "loaded prompt" },
      { type: "messageChunk", text: "loaded answer" },
      { type: "historyReplay", active: false },
    ]);
    expect(messages).toEqual([
      { type: "userMessageChunk", text: "loaded prompt" },
      { type: "messageChunk", text: "loaded answer" },
    ]);
  });

  it("starts the last-ten-user window at a user boundary, not mid-tool-group", () => {
    const buffer: HostMsg[] = [];
    for (let n = 1; n <= 12; n++) {
      buffer.push({ type: "userMessage", text: `user ${n}` });
      buffer.push({ type: "agentStart" });
      buffer.push({ type: "toolCall", call: { toolCallId: `tool-${n}`, title: `tool ${n}` } });
      buffer.push({ type: "toolCallUpdate", call: { toolCallId: `tool-${n}`, status: "completed" } });
      buffer.push({ type: "agentEnd" });
    }

    const messages = batched(buffer);
    expect(messages[0]).toEqual({ type: "userMessage", text: "user 3" });
    expect(messages.filter((m) => m.type === "userMessage")).toHaveLength(10);
    expect(messages.some((m) => m.type === "toolCall" && m.call.toolCallId === "tool-2")).toBe(false);
    expect(messages.some((m) => m.type === "toolCall" && m.call.toolCallId === "tool-3")).toBe(true);
  });

  it("counts a chunked replay prompt once and cuts at its first chunk", () => {
    const buffer: HostMsg[] = [];
    for (let n = 1; n <= 12; n++) {
      buffer.push({ type: "userMessageChunk", text: `user ${n} part A ` });
      buffer.push({ type: "userMessageChunk", text: "part B" });
      buffer.push({ type: "messageChunk", text: `answer ${n}` });
    }

    const messages = batched(buffer);
    expect(messages[0]).toEqual({ type: "userMessageChunk", text: "user 3 part A " });
    expect(messages.filter((m) => m.type === "userMessageChunk")).toHaveLength(20);
  });

  it("drops cards before the cut and renumbers cards that straddle it", () => {
    const buffer: HostMsg[] = [
      {
        type: "permissionHistoryQueue",
        permissions: [
          { title: "before", outcome: "allowed", afterUserMessage: 2, afterHistoryEvent: 2 },
          { title: "first kept", outcome: "allowed", afterUserMessage: 3, afterHistoryEvent: 3 },
          { title: "last kept", outcome: "rejected", afterUserMessage: 12, afterHistoryEvent: 12 },
        ],
      },
      {
        type: "planHistoryQueue",
        plans: [
          { text: "before", verdict: "rejected", afterUserMessage: 1, afterHistoryEvent: 1 },
          { text: "first kept", verdict: "rejected", afterUserMessage: 3, afterHistoryEvent: 3 },
          { text: "last kept", verdict: "approved", afterUserMessage: 12, afterHistoryEvent: 12 },
        ],
      },
      ...Array.from({ length: 12 }, (_, i): HostMsg[] => [
        { type: "userMessage", text: `user ${i + 1}` },
        { type: "messageChunk", text: `answer ${i + 1}` },
        { type: "usage", session: { inputTokens: i + 1 }, afterUserMessage: i + 1, afterHistoryEvent: i + 1 },
      ]).flat(),
    ];

    const messages = batched(buffer);
    const permissions = messages.find((m) => m.type === "permissionHistoryQueue");
    const plans = messages.find((m) => m.type === "planHistoryQueue");
    const usage = messages.filter((m) => m.type === "usage");
    expect(permissions).toEqual({
      type: "permissionHistoryQueue",
      permissions: [
        { title: "first kept", outcome: "allowed", afterUserMessage: 1, afterHistoryEvent: 1 },
        { title: "last kept", outcome: "rejected", afterUserMessage: 10, afterHistoryEvent: 10 },
      ],
    });
    expect(plans).toEqual({
      type: "planHistoryQueue",
      plans: [
        { text: "first kept", verdict: "rejected", afterUserMessage: 1, afterHistoryEvent: 1 },
        { text: "last kept", verdict: "approved", afterUserMessage: 10, afterHistoryEvent: 10 },
      ],
    });
    expect(usage).toHaveLength(10);
    expect(usage[0]).toMatchObject({ afterUserMessage: 1, afterHistoryEvent: 1, session: { inputTokens: 3 } });
    expect(usage[9]).toMatchObject({ afterUserMessage: 10, afterHistoryEvent: 10, session: { inputTokens: 12 } });
    const transcript = messages.filter((m) => m.type !== "permissionHistoryQueue" && m.type !== "planHistoryQueue");
    expect(transcript[0]).toEqual({ type: "userMessage", text: "user 3" });
  });

  it("drops the oldest oversized turn at a user boundary until the batch fits", () => {
    const buffer: HostMsg[] = [
      { type: "userMessage", text: "old prompt" },
      { type: "messageChunk", text: "x".repeat(REMOTE_HISTORY_BYTE_LIMIT - 100) },
      { type: "userMessage", text: "new prompt" },
      { type: "messageChunk", text: "new answer" },
    ];

    const messages = batched(buffer);
    expect(messages[0]).toEqual({ type: "userMessage", text: "new prompt" });
    expect(messages).not.toContainEqual(expect.objectContaining({ text: "old prompt" }));
    expect(Buffer.byteLength(JSON.stringify({ type: "historyBatch", messages }))).toBeLessThanOrEqual(
      REMOTE_HISTORY_BYTE_LIMIT,
    );
  });

  it("delivers an over-budget single turn rather than truncating it", () => {
    // The budget keeps a phone's reconnect cheap; it is not a safety mechanism.
    // The relay's frame ceiling is 4.5x it, so this still arrives — and the
    // largest real conversation measured on disk is 2.8 MB in total, so one
    // turn past 8 MiB is well outside anything observed.
    const buffer: HostMsg[] = [
      { type: "userMessage", text: "only prompt" },
      { type: "messageChunk", text: "z".repeat(REMOTE_HISTORY_BYTE_LIMIT + 1000) },
      { type: "messageChunk", text: "the newest words" },
    ];

    const messages = batched(buffer);
    expect(messages[0]).toEqual({ type: "userMessage", text: "only prompt" });
    expect(messages[messages.length - 1]).toEqual({ type: "messageChunk", text: "the newest words" });
  });
});

// `messageForRemote` strips capabilities that describe the DESK machine before
// a phone sees them. Nothing proved it did — and the failure mode is silent:
// someone adds capability number three, forgets the list, and every existing
// gate still passes because allowFromRemote refuses those messages anyway.
// Belt-and-braces, but the belt should be testable.
describe("capabilities a remote may see", () => {
  it("removes every desk-only capability and keeps the rest", () => {
    // Deliberately over-populated: anything NOT on the desk-only list must
    // survive, which is what catches a strip that got too greedy.
    const all = {
      uploadFile: true,
      remoteVoice: true,
      deleteActiveSession: true,
      servesMediaRanges: true,
      showInFolder: true,
      browseProjectFiles: true,
      editProjectFiles: true,
      relocateView: true,
      secondarySideBar: true,
      showOutput: true,
      toggleDevTools: true,
      previewInApp: true,
      settingsEditor: true,
    } as unknown as Parameters<typeof capabilitiesForRemote>[0];

    const seen = capabilitiesForRemote(all) as Record<string, unknown>;

    for (const key of DESK_ONLY_CAPABILITIES) {
      expect(seen, `${key} must not reach a remote`).not.toHaveProperty(key);
    }
    // The file browser is the one a remote genuinely needs — a phone has no
    // editor to fall back on, so stripping it would take the feature away.
    expect(seen.browseProjectFiles).toBe(true);
    expect(seen.editProjectFiles).toBe(true);
    expect(seen.uploadFile).toBe(true);
    expect(seen.remoteVoice).toBe(true);
  });

  it("does not mutate the host's own capabilities object", () => {
    const original = { showInFolder: true, uploadFile: true } as unknown as
      Parameters<typeof capabilitiesForRemote>[0];
    capabilitiesForRemote(original);
    // The host keeps serving its LOCAL webview from this same object.
    expect(original).toHaveProperty("showInFolder");
  });

  it("withholds removing a project from a remote driving a DESK", () => {
    // A phone must not rearrange the projects on somebody's laptop. Drawing
    // the control there is the bug this whole change is about: it rendered,
    // posted, and was dropped in silence.
    const caps = { removeProjectFolder: true, uploadFile: true } as unknown as
      Parameters<typeof capabilitiesForRemote>[0];
    const seen = capabilitiesForRemote(caps) as Record<string, unknown>;
    expect(seen).not.toHaveProperty("removeProjectFolder");
    expect(seen.uploadFile).toBe(true);
  });

  it("withholds it on a CLOUD machine too, because Hide there is one-way", () => {
    // The tempting argument is that a cloud remote is the only user, so it may
    // as well close a folder. Authority was never the problem. RECOVERY is:
    // Add project on a phone is Create and Clone, importing an existing folder
    // needs a picker no remote has, and Create refuses a destination that is
    // already on disk. A hidden project would be gone from every surface that
    // person has, under a dialog promising it could be brought back.
    const caps = { removeProjectFolder: true, uploadFile: true } as unknown as
      Parameters<typeof capabilitiesForRemote>[0];
    const seen = capabilitiesForRemote(caps) as Record<string, unknown>;
    expect(seen).not.toHaveProperty("removeProjectFolder");
    expect(seen.uploadFile).toBe(true);
  });
});

describe("a cloud environment is its own desk", () => {
  it("admits logout there, and only there", () => {
    // host-local means "this acts on the LOCAL machine", and what it protects
    // is the person sitting at it. A cloud box has no such person — the remote
    // is its only surface — so a credential that can be granted and never
    // revoked is the worse answer (cloud-environments.md; owner, 2026-08-30).
    expect(allowFromRemote("logout", "full")).toBe(false);
    expect(allowFromRemote("logout", "full", { isCloud: true })).toBe(true);
    // Tier still applies: the override changes the disposition, not the rank.
    expect(allowFromRemote("logout", "propose", { isCloud: true })).toBe(false);
  });

  it("promotes nothing else", () => {
    // The override table is the whole difference. If something else starts
    // passing on cloud, it was added here deliberately or it is a leak.
    const promoted = (Object.keys(INBOUND_DISPOSITION) as (keyof typeof INBOUND_DISPOSITION)[])
      .filter((type) => !allowFromRemote(type, "full")
        && allowFromRemote(type, "full", { isCloud: true }));
    // logout: a cloud user must be able to sign an agent OUT from the only
    // surface they have. refreshProviders: the promotion that makes a sign-in
    // stick runs from this frame, and on a cloud machine nobody else can send
    // it — withholding it made connected accounts read as disconnected after
    // a refresh (owner, 2026-08-31).
    // Every entry is here because a cloud machine has no desk to do it from:
    // signing an agent OUT, re-observing the accounts (the promotion that makes
    // a sign-in stick), and the two General preferences about this machine
    // which were otherwise read-only forever (owner, 2026-08-31).
    // removeProjectFolder joined these during 4.1.2 and was taken back out
    // before release. "The remote is the only user" establishes AUTHORITY and
    // says nothing about whether the act can be undone: on a cloud machine Add
    // project is Create and Clone only, importing an existing folder needs a
    // native picker no remote has, and Create refuses a destination that
    // already exists — so Hide there was one-way, under a confirmation that
    // promised otherwise. Reversible put-away is the archive feature, not a
    // disposition override.
    // githubLoginWithToken was briefly promoted here and is deliberately NOT:
    // it is plainly `full`, because a remote that could inject a token can
    // already `send` and answer `permissionAnswer` on that machine, so the
    // promotion protected nothing and removed the paste path from a phone
    // driving a desk.
    expect([...promoted].sort()).toEqual([
      "githubSignOut", "logout", "refreshProviders", "setTelemetryEnabled", "setThumbsFeedback",
    ]);
  });
});
