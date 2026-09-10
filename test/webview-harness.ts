// Shared test harness for driving the REAL shipped webview scripts
// (media/chat.js + its shared media components) inside a happy-dom window.
//
// happy-dom doesn't execute inline <script> text synchronously, but window.eval
// runs in the window's realm and shares its globals — webview-helpers sets
// window.GrokWebviewHelpers, and chat.js reads it at startup. We stub
// acquireVsCodeApi to capture the postMessage payloads the webview sends back to
// the extension host, then dispatch the same messages sidebar.ts posts.
//
// This file is NOT a test (it has no *.test.ts suffix, so vitest's
// include glob "test/**/*.test.ts" skips it); it's imported by the DOM tests.
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const helperSrc = read("../media/webview-helpers.js");
const settingsSrc = read("../media/settings.js");
const filePanelSrc = read("../media/file-panel.js");
const chatSrc = read("../media/chat.js");

// Mirror of getHtml()'s <body> — only the ids chat.js queries at startup matter.
export const BODY = `
  <header class="top-bar">
    <div id="session-name-chip" class="session-name-chip" hidden>
      <button id="session-name-label" class="session-name-label" type="button"></button>
      <span id="session-name-repo" class="session-name-repo" hidden></span>
      <button id="session-name-edit" class="session-name-edit icon-btn" type="button" hidden></button>
    </div>
    <button id="repo-btn" type="button"></button>
    <button id="remote-btn" hidden></button>
    <button id="history-btn"></button>
    <button id="new-btn"></button>
    <div id="session-head-actions"></div>
    <div id="repo-popover" hidden></div>
    <div id="history-popover" hidden></div>
  </header>
  <div id="session-head">
    <div id="session-head-main"><span id="session-head-title"></span><span id="session-head-sub"></span></div>
  </div>
  <main id="messages" class="messages">
    <div class="welcome" id="welcome">
      <p id="welcome-version" class="muted welcome-status-busy"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Starting</span></p>
      <div id="welcome-onboarding"></div>
    </div>
  </main>
  <footer class="composer">
    <button id="scroll-bottom-btn" class="scroll-bottom-btn"></button>
    <div class="composer-card">
      <div id="attachments"></div>
      <div class="composer-input-wrap">
        <div id="input-highlight"></div>
        <textarea id="input"></textarea>
        <button id="mic-btn"></button>
      </div>
      <button id="add-btn"></button>
      <button id="gear-btn"></button>
      <div id="donut"><svg><circle id="donut-arc"/></svg><span id="donut-label"></span></div>
      <div id="chips"></div>
      <button id="mode-btn"></button>
      <button id="send-btn"></button>
    </div>
    <div id="mode-popover" hidden></div>
    <div id="gear-popover" hidden></div>
    <div id="add-popover" hidden></div>
    <div id="context-popover" hidden></div>
    <div id="slash-popover" hidden></div>
    <div id="mention-popover" hidden></div>
  </footer>`;

export interface Posted { type: string; [k: string]: unknown }

export interface Harness {
  window: Window;
  posted: Posted[];
  doc: Document;
}

export function bootWebview(opts: {
  ready?: boolean;
  remote?: boolean;
  vscode?: boolean;
  postMessage?: (message: Posted) => unknown;
  beforeScripts?: (window: Window) => void;
} = {}): Harness {
  const window = new Window({ url: "https://localhost/" });
  const posted: Posted[] = [];
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (m: Posted) => {
      posted.push(m);
      return opts.postMessage ? opts.postMessage(m) : undefined;
    },
    setState: () => {},
    getState: () => undefined,
  });
  const doc = (window as any).document as Document;
  doc.body.innerHTML = BODY;
  if (opts.vscode) {
    doc.getElementById("session-head-actions")?.remove();
    const slot = doc.createElement("div");
    slot.id = "vscode-session-actions";
    const newBtn = doc.getElementById("new-btn");
    newBtn?.parentElement?.insertBefore(slot, newBtn.nextSibling);
  }
  // What the relay's chat.html sets before loading chat.js. Gates the remote-only
  // affordances (repo switcher) and suppresses the host-only ones.
  if (opts.remote) (window as any).grokRemoteClient = true;
  if (opts.beforeScripts) opts.beforeScripts(window);
  (window as any).eval(helperSrc);
  (window as any).eval(settingsSrc);
  // Every surface loads the shared component; each feature gates its own mount.
  (window as any).eval(filePanelSrc);
  (window as any).eval(chatSrc);
  // The webview now boots busy+locked (startup spinner) and only goes idle once
  // the host posts setBusy:false after the session is live. Most tests exercise
  // that ready state, so simulate it by default; pass { ready: false } to assert
  // the startup spinner itself.
  if (opts.ready !== false) {
    dispatch(window, { type: "setBusy", value: false });
  }
  posted.length = 0; // drop chat.js's startup {type:"ready"} so tests see only their own messages
  return { window, posted, doc };
}

/** Deliver a message to the webview exactly as the extension host would. */
export function dispatch(window: Window, data: Posted): void {
  (window as any).dispatchEvent(new (window as any).MessageEvent("message", { data }));
}

/** Click via a real bubbling MouseEvent so onclick + stopPropagation behave like the browser. */
export function click(window: Window, el: Element): void {
  el.dispatchEvent(new (window as any).MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Press (pointerdown) rather than click. The queued-block actions bind
 *  pointerdown on purpose: that block is pinned to the end of the chat and every
 *  streamed chunk re-scrolls it, so a `click` (which needs mousedown and mouseup
 *  on the SAME element) is unreliable mid-stream. Tests must exercise the event
 *  the UI actually listens for. */
export function press(window: Window, el: Element): void {
  const Ctor = (window as any).PointerEvent || (window as any).MouseEvent;
  el.dispatchEvent(new Ctor("pointerdown", { bubbles: true, cancelable: true }));
}
