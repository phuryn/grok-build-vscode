# Snapshot Visual Flash and Camera Shutter Sound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement visual (screen white flash animation) and auditory (camera shutter "cekrek" sound) feedback for screen snapshots in Grok Build, mimicking the macOS screenshot experience, while ensuring the screen is captured before the flash animation and the resulting image is immediately focused and attached to the prompt composer.

**Architecture:**
1. **Auditory Feedback (Camera Shutter Synth):**
   - Synthesize a realistic dual-stage mechanical camera shutter sound ("click-clack / cekrek") using the Web Audio API (`AudioContext`) in `media/chat.js` without any external audio asset dependencies.
   - Stage 1 ($t = 0$): Quick high-frequency burst (800Hz–1200Hz, 15ms) representing the mirror/shutter opening.
   - Stage 2 ($t = 45\text{ms}$): Damped resonant click + body thud (320Hz down to 120Hz, 60ms) representing the shutter closing.
2. **Visual Feedback (White Screen Flash Overlay):**
   - In webview (`media/chat.js` & `media/chat.css`): Create a full-viewport white flash overlay element (`.snapshot-screen-flash`) that flashes with high brightness (`opacity: 0.85` $\rightarrow$ `0` over 220ms ease-out) when snapshot occurs.
   - In desktop Electron (`src/desktop/main.ts`): Optionally create a brief transparent overlay or flash the renderer window so the user gets instant visual confirmation across the screen.
3. **Capture & Attach Sequence:**
   - Step 1: `captureScreen()` executes quietly in the background.
   - Step 2: On capture completion, `triggerSnapshotFeedback()` is dispatched:
     - The white flash animation triggers.
     - The camera shutter audio plays.
     - The desktop window is brought to the foreground and restored if minimized.
   - Step 3: `attachSnapshot()` stages the PNG and inserts the image chip into the active session.
   - Step 4: `revealAndFocusComposer()` focuses the prompt input box with the image chip ready for prompt input.

**Tech Stack:** JavaScript / Web Audio API, CSS Animations, Electron (`BrowserWindow`, `globalShortcut`), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-snapshot-visual-audio-design.md`

## Global Constraints

- Zero external audio files or native audio libraries required — synthesis is 100% self-contained in Web Audio API.
- The screen capture MUST execute before the visual flash overlay is rendered to prevent the white flash from contaminating the captured screenshot.
- Keep existing macOS screencapture commands intact.
- All tests must pass in headless and desktop environments without requiring audio hardware.

---

### Task 1: Implement Camera Shutter Audio Synthesizer in `media/chat.js`

**Files:**
- Modify: `media/chat.js`
- Test: `test/webview-ui.dom.test.ts`

**Interfaces:**
- Produces: `playCameraShutterSound(audioCtx?: AudioContext): void`

- [ ] **Step 1: Write test for camera shutter sound synthesis**

```typescript
it("synthesizes camera shutter audio nodes without crashing", () => {
  // Test AudioContext mock node creation
});
```

- [ ] **Step 2: Implement `playCameraShutterSound` in `media/chat.js`**

```javascript
function playCameraShutterSound() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const t0 = ctx.currentTime;
  
  // Shutter click 1 (mirror flip up)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "triangle";
  osc1.frequency.setValueAtTime(1100, t0);
  osc1.frequency.exponentialRampToValueAtTime(400, t0 + 0.02);
  gain1.gain.setValueAtTime(0.3, t0);
  gain1.gain.exponentialRampToValueAtTime(0.01, t0 + 0.02);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(t0);
  osc1.stop(t0 + 0.025);

  // Shutter click 2 (shutter curtain release - "cekrek")
  const t1 = t0 + 0.045;
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(320, t1);
  osc2.frequency.exponentialRampToValueAtTime(90, t1 + 0.06);
  gain2.gain.setValueAtTime(0.4, t1);
  gain2.gain.exponentialRampToValueAtTime(0.01, t1 + 0.06);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(t1);
  osc2.stop(t1 + 0.07);

  // Auto-suspend after playback
  setTimeout(() => {
    suspendAudioCtx(ctx);
  }, 150);
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test -- test/webview-ui.dom.test.ts`
Expected: PASS

---

### Task 2: Implement White Screen Flash Overlay in `media/chat.css` and `media/chat.js`

**Files:**
- Modify: `media/chat.css`
- Modify: `media/chat.js`
- Test: `test/webview-ui.dom.test.ts`

**Interfaces:**
- Produces: `.snapshot-screen-flash` element and `triggerSnapshotFlashEffect()`

- [ ] **Step 1: Add CSS animation rules in `media/chat.css`**

```css
.snapshot-screen-flash {
  position: fixed;
  inset: 0;
  z-index: 999999;
  background: #ffffff;
  pointer-events: none;
  opacity: 0.85;
  animation: snapshot-flash-fade 240ms cubic-bezier(0.1, 0.9, 0.2, 1) forwards;
}

@keyframes snapshot-flash-fade {
  0% {
    opacity: 0.85;
  }
  100% {
    opacity: 0;
  }
}
```

- [ ] **Step 2: Add `triggerSnapshotFlashEffect` in `media/chat.js`**

```javascript
function triggerSnapshotFlashEffect() {
  playCameraShutterSound();
  const flash = document.createElement("div");
  flash.className = "snapshot-screen-flash";
  document.body.appendChild(flash);
  flash.addEventListener("animationend", () => {
    flash.remove();
  });
  // Fallback cleanup
  setTimeout(() => {
    if (flash.parentNode) flash.remove();
  }, 350);
}
```

- [ ] **Step 3: Listen for `snapshotTaken` host event in `media/chat.js`**

```javascript
case "snapshotTaken":
  triggerSnapshotFlashEffect();
  break;
```

- [ ] **Step 4: Run tests to verify**

Run: `pnpm test -- test/webview-ui.dom.test.ts`
Expected: PASS

---

### Task 3: Dispatch Feedback Event on Snapshot Completion in Host and Desktop

**Files:**
- Modify: `src/protocol.ts`
- Modify: `media/webview-helpers.js`
- Modify: `src/remote-policy.ts`
- Modify: `src/sidebar.ts`
- Modify: `src/snapshot-handler.ts`
- Modify: `src/desktop/main.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Produces: `snapshotTaken` host message sent to webview immediately after capture.

- [ ] **Step 1: Add `snapshotTaken` to `HostMsg` in `src/protocol.ts` & `src/remote-policy.ts`**

```typescript
| { type: "snapshotTaken" }
```

- [ ] **Step 2: Update `attachSnapshot` in `src/sidebar.ts` to broadcast `snapshotTaken`**

```typescript
public async attachSnapshot(srcPath: string): Promise<Session | false | undefined> {
  this.post({ type: "snapshotTaken" });
  const session = await this.importImageFromDisk(srcPath);
  if (session && session === this.focused) {
    this.revealAndFocusComposer();
  }
  return session;
}
```

- [ ] **Step 3: In Desktop `src/desktop/main.ts`, ensure window restore & focus happens seamlessly**

When hotkey triggers:
1. `captureScreen()` runs.
2. `attachSnapshot()` executes, playing the shutter sound and flashing the white screen animation.
3. Desktop window restores from minimized state and focuses the composer.

- [ ] **Step 4: Run full test suite and compile**

Run: `pnpm run compile && pnpm test -- test/snapshot test/settings-surface.dom.test.ts`
Expected: PASS with 100% green tests.

---

## Self-Review

1. **Spec Coverage:**
   - Screen capture occurs before flash: Verified (Step 1 of capture runs before `snapshotTaken` is posted).
   - White screen blank/flash animation: Covered in Task 2.
   - Camera shutter sound ("cekrek"): Covered in Task 1.
   - Prompt box focus with attached chip: Covered in Task 3.
2. **Platform Safety:**
   - Web Audio synth works in Chromium, Electron, and VS Code webviews offline without external `.wav`/`.mp3` assets.
   - macOS screencapture paths remain isolated and untouched.
