/**
 * Add project, in the real webview.
 *
 * Three ways in, three surfaces. What only a DOM run can show is the wiring:
 * that the menu carries what THIS host offers, that the form posts a name or a
 * URL and never a path, that a failure keeps the form open with something the
 * user can act on, and that a host too old to know any of this still gets the
 * folder picker it always had.
 *
 * The VS Code projects rail is a second renderer of the same shared menu and
 * form (media/webview-helpers.js); test/vscode-projects-rail.dom.test.ts covers
 * that one.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const CAPS = {
  uploadFile: true,
  remoteVoice: true,
  addProjectFolder: true,
  createProject: true,
  cloneProject: true,
};

function boot(opts: { remote?: boolean; caps?: Record<string, unknown>; coding?: boolean } = {}) {
  const h = bootWebview({ remote: opts.remote });
  dispatch(h.window, {
    type: "initialState",
    effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.17.2",
    showThinking: false, expandCommandOutputs: false, steerByDefault: false,
    soundNotifications: false, processingSound: false, readRepliesAloud: false,
    appPurpose: opts.coding ? "coding" : "knowledge",
    capabilities: opts.caps ?? CAPS,
  });
  dispatch(h.window, { type: "projectSetup", root: "~/Grok Build" });
  h.posted.length = 0;
  return h;
}

/** The rail's + button is only mounted on a rail-bearing surface, so drive the
 *  same entry point the no-project empty state uses. */
function openMenu(h: Harness) {
  h.window.eval(`document.body.__openAddProject()`);
}

const menuItems = (h: Harness) =>
  [...h.doc.querySelectorAll(".rail-menu-item")].map(
    (el) => (el.querySelector(".rail-menu-label") || el).textContent?.trim() || "",
  );
const form = (h: Harness) => h.doc.querySelector(".add-project-form") as HTMLElement | null;
const input = (h: Harness) => h.doc.querySelector(".add-project-input") as HTMLInputElement;
const dest = (h: Harness) => (h.doc.querySelector(".add-project-dest")?.textContent || "").trim();
const problem = (h: Harness) => h.doc.querySelector(".add-project-error") as HTMLElement | null;
const fix = (h: Harness) => h.doc.querySelector(".add-project-fix") as HTMLButtonElement | null;
const submit = (h: Harness) =>
  h.doc.querySelector(".add-project-primary") as HTMLButtonElement;

/** Expose the menu opener the rail button would call. chat.js keeps it inside
 *  its IIFE, so reach it the way the onboarding card does. */
function installOpener(h: Harness) {
  h.window.eval(`
    document.body.__openAddProject = () => {
      const card = document.getElementById("welcome-onboarding");
      card.innerHTML = '<button class="onb-action" type="button" data-act="addProjectFolder">Add project folder</button>';
      card.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };
  `);
}

describe("add project", () => {
  it("offers cloning in Knowledge work, at the top, the same as in Coding", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["Clone from GitHub", "New project", "Import a folder"]);
  });

  it("adds cloning in Coding, at the top, and takes nothing away", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["Clone from GitHub", "New project", "Import a folder"]);
  });

  it("explains each entry, because they differ by a verb", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    const descriptions = [...h.doc.querySelectorAll(".rail-menu-desc")].map((el) => el.textContent);
    expect(descriptions).toEqual([
      "Pick a repository, or type a URL.",
      "Name it. We make the folder.",
      "Choose one you already have.",
    ]);
  });

  it("stays a plain picker on a host that offers nothing else", () => {
    // An older host advertises `addProjectFolder` alone. One way in is a click,
    // not a menu that asks permission to be a click.
    const h = boot({ caps: { uploadFile: true, remoteVoice: true, addProjectFolder: true } });
    installOpener(h);
    openMenu(h);
    expect(h.doc.querySelector(".rail-menu")).toBeNull();
    expect(h.posted).toContainEqual({ type: "addProjectFolder" });
  });

  it("still opens the picker when capabilities have not arrived yet", () => {
    // The no-project card can be on screen before `initialState` lands, and its
    // button has to do something.
    const h = bootWebview();
    installOpener(h);
    openMenu(h);
    expect(h.posted).toContainEqual({ type: "addProjectFolder" });
  });

  it("hides importing from a phone but keeps the other two", () => {
    // Opening a native picker is host-local — there is no dialog for a remote to
    // see. Naming and cloning send a name and a URL, so the host decides where.
    const h = boot({ remote: true, coding: true });
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["Clone from GitHub", "New project"]);
  });

  it("shows the destination as you type, and posts a NAME", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    const newItem = [...h.doc.querySelectorAll(".rail-menu-item")].find((el) =>
      el.textContent?.includes("New project"),
    )!;
    click(h.window, newItem);
    expect(form(h)).toBeTruthy();
    expect(dest(h)).toBe("~/Grok Build/…");
    input(h).value = "Q3 Positioning";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(dest(h)).toBe("~/Grok Build/Q3 Positioning");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({ type: "createProject", name: "Q3 Positioning" });
    // A name, never a path. That is what lets this reach the host from a phone.
    expect(JSON.stringify(h.posted)).not.toContain("/Grok Build/");
  });

  it("previews the folder a clone URL implies, and posts the URL", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    input(h).value = "https://github.com/phuryn/grok-remote.git";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(dest(h)).toBe("~/Grok Build/grok-remote");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({
      type: "cloneProject",
      url: "https://github.com/phuryn/grok-remote.git",
    });
  });

  it("refuses to submit an empty field", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(submit(h).disabled).toBe(true);
    click(h.window, submit(h));
    expect(h.posted.some((m) => m.type === "createProject")).toBe(false);
  });

  it("says what it is doing while the host works", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", busy: "clone" });
    // Label plus the shared .blink-dots, not a static "…": a frozen ellipsis
    // read as a stuck button (owner, 2026-09-01). textContent flattens the
    // three dot spans, so assert the parts rather than a single string.
    expect(submit(h).textContent).toContain("Cloning");
    expect(submit(h).querySelector(".blink-dots")).toBeTruthy();
    expect(submit(h).querySelectorAll(".blink-dots span")).toHaveLength(3);
    expect(submit(h).disabled).toBe(true);
    expect(input(h).disabled).toBe(true);
  });

  it("keeps the form open on failure, with the error to read", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup", root: "~/Grok Build", error: '"Q3" is already in ~/Grok Build.',
    });
    expect(form(h)).toBeTruthy();
    expect(problem(h)?.hidden).toBe(false);
    expect(problem(h)?.textContent).toContain("already in");
    // No fix offered for a failure nothing can fix for them.
    expect(fix(h)?.hidden).toBe(true);
  });

  it("offers to sign in to GitHub when that is what would fix it", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "auth-gh",
    });
    expect(fix(h)?.hidden).toBe(false);
    expect(fix(h)?.textContent).toBe("Sign in to GitHub");
    click(h.window, fix(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
    // The form stays up: signing in happens in a terminal, and the user comes
    // back here to try again.
    expect(form(h)).toBeTruthy();
  });

  it("posts setupGithubCli from a remote when the host can run headless GitHub sign-in", () => {
    const h = boot({
      remote: true,
      coding: true,
      caps: { ...CAPS, remoteGithubSignIn: true },
    });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "auth-gh",
    });
    click(h.window, fix(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
  });

  it("does not post setupGithubCli from a remote at a host that would drop it", () => {
    const h = boot({ remote: true, coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "auth-gh",
    });
    click(h.window, fix(h)!);
    expect(h.posted.some((m) => m.type === "setupGithubCli")).toBe(false);
    expect(problem(h)?.textContent).toMatch(/Sign in to GitHub on the computer/);
  });

  const githubBox = (h: Harness) => h.doc.querySelector(".add-project-github") as HTMLElement | null;
  const githubConnect = (h: Harness) =>
    h.doc.querySelector(".add-project-github-connect") as HTMLButtonElement | null;
  const githubOpen = (h: Harness) =>
    h.doc.querySelector(".add-project-github-open") as HTMLAnchorElement | null;

  it("step 1 is a choice, with no code, until they press connect", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    const box = githubBox(h);
    expect(box?.hidden).toBe(false);
    expect(box?.dataset.phase).toBe("choice");
    expect(githubConnect(h)?.textContent).toBe("Connect with GitHub CLI");
    expect(h.doc.querySelector(".add-project-github-advanced")?.textContent)
      .toBe("Use a token instead");
    expect(box?.textContent).not.toContain("0D15-6BD9");
    expect(h.doc.querySelector(".add-project-github-token")?.hidden).toBe(true);
    expect(h.doc.querySelector(".add-project-github-card")?.hidden).toBe(true);
  });

  it("pressing connect replaces the choice with the device card", () => {
    const h = boot({
      remote: true,
      coding: true,
      caps: { ...CAPS, remoteGithubSignIn: true },
    });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    h.posted.length = 0;
    click(h.window, githubConnect(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
    expect(githubBox(h)?.dataset.phase).toBe("cli");
    expect(githubConnect(h)?.closest(".add-project-github-choice")?.hidden).toBe(true);
    expect(h.doc.querySelector(".add-project-github-card")?.hidden).toBe(false);
    expect(input(h).hidden).toBe(true);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      github: {
        status: "waiting",
        url: "https://github.com/login/device",
        code: "0D15-6BD9",
      },
    });
    expect(githubBox(h)?.textContent).toContain("0D15-6BD9");
    expect(githubBox(h)?.textContent).toContain("Open the link, then confirm this code");
    expect(githubBox(h)?.textContent).toContain("Keep this page open");
    const link = githubOpen(h);
    expect(link?.hidden).toBe(false);
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("https://github.com/login/device");
    expect(link?.textContent).toBe("Open the sign-in page");
    expect(link?.target).toBe("_blank");
    expect(link?.classList.contains("onb-action")).toBe(true);
    expect(h.doc.querySelector(".add-project-github-copy")).toBeTruthy();
    expect(fix(h)?.hidden).toBe(true);
  });

  it("stays open on success and tells them to clone again", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    click(h.window, githubConnect(h)!);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      github: { status: "done", message: "Signed in to GitHub. Clone again." },
    });
    expect(form(h)).toBeTruthy();
    expect(h.doc.querySelector(".add-project-github")?.textContent).toContain("Clone again");
  });

  it("a waiting GitHub login with no form open leaves the DOM alone", () => {
    const h = boot({ remote: true, coding: true, caps: { ...CAPS, remoteGithubSignIn: true } });
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      github: {
        status: "waiting",
        url: "https://github.com/login/device",
        code: "0D15-6BD9",
      },
    });
    expect(form(h)).toBeNull();
    expect(h.doc.querySelector(".add-project-scrim")).toBeNull();
    expect(githubBox(h)).toBeNull();
  });

  it("reopening the form returns to step 1 and cancels the in-flight login", () => {
    const h = boot({
      remote: true,
      coding: true,
      caps: { ...CAPS, remoteGithubSignIn: true },
    });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    click(h.window, githubConnect(h)!);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      github: {
        status: "waiting",
        url: "https://github.com/login/device",
        code: "0D15-6BD9",
      },
    });
    expect(githubBox(h)?.textContent).toContain("0D15-6BD9");
    h.posted.length = 0;
    click(h.window, h.doc.querySelector(".add-project-btn:not(.add-project-primary)") as HTMLElement);
    expect(form(h)).toBeNull();
    expect(h.posted).toContainEqual({ type: "cancelDeviceLogin", provider: "github" });
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(form(h)).toBeTruthy();
    expect(githubBox(h)?.dataset.phase).toBe("choice");
    expect(githubBox(h)?.textContent).not.toContain("0D15-6BD9");
    expect(githubConnect(h)).toBeTruthy();
  });

  it("ignores github on an older frame that does not carry it", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "auth-gh",
    });
    expect(githubBox(h)?.dataset.phase).toBe("choice");
    expect(h.doc.querySelector(".add-project-github-card")?.hidden).toBe(true);
    expect(fix(h)?.hidden).toBe(false);
  });

  it("names the install command when the CLI is missing", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "install-gh",
      fixCommand: "winget install --id GitHub.cli -e",
    });
    // Nobody should be asked to approve a command they cannot read.
    expect(fix(h)?.textContent).toContain("winget install --id GitHub.cli -e");
    click(h.window, fix(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "install" });
  });

  /**
   * Installing has no headless path and is not getting one — a package manager
   * asks for elevation, so the host opens a terminal. On a cloud machine that
   * terminal is an Xvfb screen nobody is at, and pressing again just opens
   * another. The sign-in capability says the host can SIGN IN headlessly; it
   * says nothing about installing, and admitting every fix behind it put the
   * inaccessible-terminal dead end straight back on this branch.
   *
   * Found by review before release.
   */
  it("never posts an install from a remote, however capable the host says it is", () => {
    // Merge, don't replace: the form needs the project capabilities to render
    // at all, and a bare override silently produces a page with no menu.
    const h = boot({ coding: true, remote: true, caps: { ...CAPS, remoteGithubSignIn: true } });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "install-gh",
      fixCommand: "sudo apt install gh",
    });
    click(h.window, fix(h)!);
    expect(h.posted.some((m: { type?: string }) => m.type === "setupGithubCli")).toBe(false);
    // And it says something a person can act on instead of going quiet.
    expect(h.doc.querySelector(".add-project-error")?.textContent || "")
      .toMatch(/GitHub CLI/i);
  });

  it("clears a stale fix when the next failure does not earn one", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "auth", fix: "auth-gh" });
    expect(fix(h)?.hidden).toBe(false);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "Could not resolve host." });
    expect(fix(h)?.hidden).toBe(true);
  });

  it("closes only on done — not on a failure that also stopped being busy", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "nope" });
    expect(form(h)).toBeTruthy();
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", done: true });
    expect(form(h)).toBeNull();
  });

  it("closes on Escape and on Cancel", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    const cancel = h.doc.querySelector(".add-project-btn:not(.add-project-primary)") as HTMLElement;
    click(h.window, cancel);
    expect(form(h)).toBeNull();

    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(form(h)).toBeTruthy();
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(form(h)).toBeNull();
  });

  it("stops listening for Escape once the form is gone", () => {
    // Capture-phase listener: leaving it attached would swallow Escape
    // everywhere else in the app for the rest of the session.
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    let reached = false;
    h.doc.addEventListener("keydown", () => { reached = true; });
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reached).toBe(true);
  });

  const optionLabels = (h: Harness) =>
    [...h.doc.querySelectorAll(".add-project-option")].map((el) => el.textContent || "");

  it("filters the fetched list locally and offers a typed URL as a row", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: true, login: "phuryn", cliPresent: true },
    });
    dispatch(h.window, {
      type: "githubRepos",
      repos: [
        { nameWithOwner: "phuryn/afkpilot", isPrivate: false, updatedAt: "2026-09-03T21:55:15Z" },
        { nameWithOwner: "phuryn/secret", isPrivate: true, updatedAt: "2026-09-01T00:00:00Z" },
      ],
    });
    expect(optionLabels(h).join("\n")).toMatch(/afkpilot/);
    expect(optionLabels(h).join("\n")).toMatch(/secret/);
    input(h).value = "afk";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(optionLabels(h).join("\n")).toMatch(/afkpilot/);
    expect(optionLabels(h).join("\n")).not.toMatch(/secret/);
    input(h).value = "https://github.com/you/other";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(optionLabels(h).some((t) => t.includes("Clone https://github.com/you/other"))).toBe(true);
    click(h.window, h.doc.querySelector(".add-project-option")!);
    expect(h.posted).toContainEqual({ type: "cloneProject", url: "https://github.com/you/other" });
  });

  it("keeps the public URL path open when GitHub is not connected", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    expect(githubConnect(h)).toBeTruthy();
    input(h).value = "https://github.com/phuryn/afkpilot";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(optionLabels(h).some((t) => t.includes("Clone https://github.com/phuryn/afkpilot"))).toBe(true);
    expect(submit(h).disabled).toBe(false);
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({
      type: "cloneProject",
      url: "https://github.com/phuryn/afkpilot",
    });
  });

  it("runs Connect from the step-1 CLI button", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    h.posted.length = 0;
    click(h.window, githubConnect(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
  });

  // The relay serves this client, so it is always as new as the last deploy
  // while the extension is whatever the person installed — "older host" is the
  // ordinary case here, not an edge one. A host predating `remoteGithubSignIn`
  // DROPS `setupGithubCli`, so posting it anyway leaves a button that does
  // nothing at all. The post-clone fix row has always checked this; the
  // picker's own Connect control is a second entry point to the same action.
  const openConnectChoice = (h: Harness) => {
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "githubState", github: { connected: false, cliPresent: true } });
    return githubConnect(h)!;
  };

  it("explains instead of posting a message an older host would drop", () => {
    const h = boot({ remote: true, caps: { ...CAPS, remoteGithubSignIn: false } });
    click(h.window, openConnectChoice(h));
    expect(h.posted.some((m) => m.type === "setupGithubCli")).toBe(false);
    expect(h.doc.querySelector(".add-project-form")!.textContent).toMatch(/terminal|too old/i);
    expect(githubBox(h)?.dataset.phase).toBe("choice");
  });

  it("still connects when the host advertises that it can", () => {
    const h = boot({ remote: true, caps: { ...CAPS, remoteGithubSignIn: true } });
    h.posted.length = 0;
    click(h.window, openConnectChoice(h));
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
  });

  it("the token path is a second step, not a field that is simply present", () => {
    const h = boot({
      remote: true,
      coding: true,
      caps: { ...CAPS, remoteGithubSignIn: true },
    });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    expect(h.doc.querySelector(".add-project-github-token")?.hidden).toBe(true);
    click(h.window, h.doc.querySelector(".add-project-github-advanced") as HTMLElement);
    expect(githubBox(h)?.dataset.phase).toBe("token");
    expect(h.doc.querySelector(".add-project-github-token")?.hidden).toBe(false);
    expect(h.doc.querySelector(".add-project-github-token-input")).toBeTruthy();
    expect(githubConnect(h)?.closest(".add-project-github-choice")?.hidden).toBe(true);
  });
});
