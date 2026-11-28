import { describe, expect, it } from "vitest";
import {
  describeFfmpegProblem,
  ffmpegInstallHint,
  resolveConfiguredFfmpeg,
  type FfmpegEnv,
} from "../src/ffmpeg-locate";

/** A machine described as a set of files that exist. */
const machine = (opts: {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  files?: string[];
  dirs?: string[];
}): FfmpegEnv => ({
  platform: opts.platform ?? "darwin",
  pathEnv: opts.pathEnv ?? "/usr/bin:/bin",
  isFile: (p) => (opts.files ?? []).includes(p),
  isDirectory: (p) => (opts.dirs ?? []).includes(p),
});

describe("finding ffmpeg when PATH is stripped", () => {
  it("finds the Homebrew binary a GUI app's PATH cannot see", () => {
    // The desktop app, launched from Finder: PATH is the bare system one, and
    // ffmpeg is where `brew install` put it. This is the case that cost an
    // evening — the user had ffmpeg, `which` found it, the app did not.
    const r = resolveConfiguredFfmpeg(
      "",
      machine({ pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin", files: ["/opt/homebrew/bin/ffmpeg"] }),
    );
    expect(r).toEqual({ ok: true, path: "/opt/homebrew/bin/ffmpeg", source: "well-known" });
  });

  it("prefers PATH over the well-known list", () => {
    // Someone with a deliberately different ffmpeg on PATH must keep getting it;
    // the fallback exists to rescue a stripped environment, not to override a
    // configured one.
    const r = resolveConfiguredFfmpeg(
      "",
      machine({
        pathEnv: "/opt/custom/bin:/usr/bin",
        files: ["/opt/custom/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"],
      }),
    );
    expect(r).toEqual({ ok: true, path: "ffmpeg", source: "path" });
  });

  it("falls back through Intel Homebrew and MacPorts", () => {
    expect(
      resolveConfiguredFfmpeg("", machine({ files: ["/usr/local/bin/ffmpeg"] })),
    ).toMatchObject({ path: "/usr/local/bin/ffmpeg" });
    expect(
      resolveConfiguredFfmpeg("", machine({ files: ["/opt/local/bin/ffmpeg"] })),
    ).toMatchObject({ path: "/opt/local/bin/ffmpeg" });
  });

  it("reports not-installed rather than guessing", () => {
    expect(resolveConfiguredFfmpeg("", machine({}))).toEqual({ ok: false, reason: "not-installed" });
  });

  it("looks for ffmpeg.exe on Windows", () => {
    const r = resolveConfiguredFfmpeg(
      "",
      machine({ platform: "win32", pathEnv: "C:\\tools;C:\\Windows", files: ["C:\\tools\\ffmpeg.exe"] }),
    );
    expect(r).toEqual({ ok: true, path: "ffmpeg.exe", source: "path" });
  });
});

describe("an explicit grok.ffmpegPath", () => {
  it("wins even when a well-known copy exists", () => {
    const r = resolveConfiguredFfmpeg(
      "/opt/mine/ffmpeg",
      machine({ files: ["/opt/mine/ffmpeg", "/opt/homebrew/bin/ffmpeg"] }),
    );
    expect(r).toEqual({ ok: true, path: "/opt/mine/ffmpeg", source: "configured" });
  });

  it("names the Cellar-directory mistake and offers the real binary", () => {
    // `brew info ffmpeg` prints the Cellar root. Pasting it produced
    // `spawn /opt/homebrew/Cellar/ffmpeg EACCES` — macOS refusing to execute a
    // directory, reported as an errno with no clue what to do about it.
    const r = resolveConfiguredFfmpeg(
      "/opt/homebrew/Cellar/ffmpeg",
      machine({
        dirs: ["/opt/homebrew/Cellar/ffmpeg"],
        files: ["/opt/homebrew/Cellar/ffmpeg/bin/ffmpeg"],
      }),
    );
    expect(r).toEqual({
      ok: false,
      reason: "configured-is-directory",
      configured: "/opt/homebrew/Cellar/ffmpeg",
      hint: "/opt/homebrew/Cellar/ffmpeg/bin/ffmpeg",
    });
    expect(describeFfmpegProblem(r)).toContain("folder, not a program");
    expect(describeFfmpegProblem(r)).toContain("/opt/homebrew/Cellar/ffmpeg/bin/ffmpeg");
  });

  it("still reports a directory when no binary sits under it", () => {
    const r = resolveConfiguredFfmpeg("/tmp/empty", machine({ dirs: ["/tmp/empty"] }));
    expect(r).toMatchObject({ reason: "configured-is-directory", hint: undefined });
  });

  it("distinguishes a wrong path from nothing installed", () => {
    const r = resolveConfiguredFfmpeg("/nope/ffmpeg", machine({ files: ["/opt/homebrew/bin/ffmpeg"] }));
    // Deliberately NOT silently substituting the working copy: quietly running a
    // different binary than the one named makes a misconfiguration undebuggable.
    expect(r).toEqual({ ok: false, reason: "configured-missing", configured: "/nope/ffmpeg" });
  });

  it("treats whitespace as unset", () => {
    expect(resolveConfiguredFfmpeg("   ", machine({ files: ["/opt/homebrew/bin/ffmpeg"] }))).toMatchObject({
      source: "well-known",
    });
  });
});

describe("what we tell someone who has no ffmpeg", () => {
  it("offers to run brew on macOS, but only when brew exists", () => {
    expect(ffmpegInstallHint("darwin", true)).toEqual({ command: "brew install ffmpeg", offerToRun: true });
    // Without Homebrew the next step is installing Homebrew, which is not a
    // decision this extension makes for someone.
    expect(ffmpegInstallHint("darwin", false)).toBeUndefined();
  });

  it("shows the command but does not offer to run it elsewhere", () => {
    // winget/apt install into a directory the running editor's PATH does not yet
    // contain, so a one-click button would appear to succeed and change nothing.
    expect(ffmpegInstallHint("win32", false)).toEqual({ command: "winget install ffmpeg", offerToRun: false });
    expect(ffmpegInstallHint("linux", false)).toEqual({ command: "sudo apt install ffmpeg", offerToRun: false });
  });

  it("puts the command in the message, not just behind a button", () => {
    const msg = describeFfmpegProblem({ ok: false, reason: "not-installed" }, ffmpegInstallHint("darwin", true));
    expect(msg).toContain("brew install ffmpeg");
  });

  it("falls back to the download page when there is no command to give", () => {
    const msg = describeFfmpegProblem({ ok: false, reason: "not-installed" }, undefined);
    expect(msg).toContain("ffmpeg.org");
  });
});
