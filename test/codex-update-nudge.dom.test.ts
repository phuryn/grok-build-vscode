import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function seed(remote: boolean, updateAvailable = true) {
  const h = bootWebview({ remote, ready: false });
  const provider = { id: "codex", connected: true, cliVersion: updateAvailable ? "0.149.0" : "0.153.4",
    latestCliVersion: "0.153.4", updateAvailable, cliUpdate: { status: "idle" } };
  dispatch(h.window, { type: "providerState", providers: [provider] });
  dispatch(h.window, { type: "initialized", info: { provider: "codex", version: provider.cliVersion } });
  dispatch(h.window, { type: "setBusy", value: false });
  return { ...h, provider };
}

describe.each([false, true])("Codex welcome update nudge (remote=%s)", (remote) => {
  it("offers the older CLI an update through a visible in-app confirmation", async () => {
    const h = seed(remote);
    const nudge = h.doc.getElementById("welcome-codex-update");
    expect(nudge?.textContent).toContain("v0.149.0 is older than v0.153.4");
    click(h.window, nudge!.querySelector("button")!);
    expect(h.doc.querySelector(".confirm-overlay")).toBeTruthy();
    expect(h.posted.some((p) => p.type === "updateCodex")).toBe(false);
    const confirm = [...h.doc.querySelectorAll(".confirm-overlay button")].find((b) => b.textContent === "Update Codex CLI");
    expect(confirm).toBeTruthy();
    click(h.window, confirm!);
    await Promise.resolve();
    expect(h.posted).toContainEqual({ type: "updateCodex" });
  });

  it("does not suggest updates for a current CLI, absent provider, or old host", () => {
    const h = seed(remote, false);
    expect(h.doc.getElementById("welcome-codex-update")).toBeNull();
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, connected: false, updateAvailable: true }] });
    expect(h.doc.getElementById("welcome-codex-update")).toBeNull();
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, updateAvailable: true, cliUpdate: undefined }] });
    expect(h.doc.getElementById("welcome-codex-update")).toBeNull();
  });

  it("keeps progress and outcome visible after an update, and hides with the welcome", () => {
    const h = seed(remote);
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, cliUpdate: { status: "running", message: "Updating Codex CLI…" } }] });
    expect(h.doc.getElementById("welcome-codex-update")?.textContent).toContain("Updating Codex CLI…");
    expect(h.doc.querySelector("#welcome-codex-update button")).toBeNull();
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, updateAvailable: false, cliUpdate: { status: "succeeded", message: "Update completed · Codex CLI v0.153.4" } }] });
    expect(h.doc.getElementById("welcome-codex-update")?.textContent).toContain("Update completed");
    dispatch(h.window, { type: "userMessage", text: "Hello" });
    expect(h.doc.getElementById("welcome")?.hidden).toBe(true);
    expect(h.doc.getElementById("welcome-codex-update")?.closest("#welcome")).toBeTruthy();
  });

  it("looks like an offer only while there is something to take", () => {
    // The owner could not see the nudge on a phone (2026-09-06): grey sentence,
    // grey underlined link, sitting in the box the quiet advice tips use. An
    // offer carries the foreground weight; a progress or completion line is a
    // status and stays ambient.
    const h = seed(remote);
    const classes = () => [...h.doc.getElementById("welcome-codex-update")!.classList];
    expect(classes()).toContain("welcome-cli-update-offer");
    expect(classes()).not.toContain("muted");
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, cliUpdate: { status: "running", message: "Updating Codex CLI…" } }] });
    expect(classes()).toContain("muted");
    expect(classes()).not.toContain("welcome-cli-update-offer");
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, updateAvailable: false, cliUpdate: { status: "succeeded", message: "Update completed · Codex CLI v0.153.4" } }] });
    expect(classes()).toContain("muted");
    // A retry is something to take, so it is an offer again.
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, cliUpdate: { status: "failed", message: "Update failed: offline" } }] });
    expect(classes()).toContain("welcome-cli-update-offer");
  });

  it("offers a retry after a failed update", () => {
    const h = seed(remote);
    dispatch(h.window, { type: "providerState", providers: [{ ...h.provider, cliUpdate: { status: "failed", message: "Update failed: offline" } }] });
    expect(h.doc.getElementById("welcome-codex-update")?.textContent).toContain("Update failed: offline");
    expect(h.doc.querySelector("#welcome-codex-update button")).toBeTruthy();
  });
});
