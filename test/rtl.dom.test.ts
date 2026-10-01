// RTL/bidi content support — drives the REAL shipped media/chat.js in a
// happy-dom window and asserts the dir="auto" half of the fix (applyAutoDir):
// every block element renderMarkdown emits (ul/ol/li, h1-h3, td/th) takes its
// direction from its own first strong character, on every markdown surface —
// agent stream, user bubble, plan cards — while code blocks stay UNdirected
// (chat.css pins them LTR). The loose-prose half (unicode-bidi: plaintext on
// the containers) is pure CSS, which happy-dom doesn't lay out — that part is
// eyeballed with an Arabic prompt (the report that motivated this).
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const ARABIC_MD = [
  "## عنوان تجريبي",
  "",
  "مرحباً! هذا نص تجريبي.",
  "",
  "- عنصر أول",
  "- عنصر ثانٍ",
  "",
  "| الاسم | المدينة |",
  "|---|---|",
  "| غازي | الرياض |",
  "",
  "```js",
  "const x = 1;",
  "```",
].join("\n");

describe("RTL content (real chat.js in a DOM)", () => {
  it("sets dir=auto on h5/h6 and nested quotes in streamed replies", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "messageChunk", text: "##### عنوان\n\n> ###### عنوان داخلي\n>\n> > اقتباس" });
    dispatch(window, { type: "promptComplete" });
    const blocks = doc.querySelectorAll(".msg.agent .body h5, .msg.agent .body h6, .msg.agent .body blockquote");
    expect(blocks.length).toBe(4);
    for (const el of blocks) expect(el.getAttribute("dir")).toBe("auto");
  });

  it("agent markdown: every block element gets dir=auto, code gets none", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "messageChunk", text: ARABIC_MD });
    dispatch(window, { type: "promptComplete" }); // commitAgentTurn → synchronous flush

    const body = doc.querySelector(".msg.agent .body")!;
    const blocks = body.querySelectorAll("ul, li, h2, td, th");
    expect(blocks.length).toBeGreaterThanOrEqual(6); // ul + 2 li + h2 + 2 th + 2 td
    for (const el of blocks) expect(el.getAttribute("dir")).toBe("auto");

    // Code is pinned LTR by chat.css — dir=auto must never land on it.
    const pre = body.querySelector(".code-block pre")!;
    expect(pre).not.toBeNull();
    expect(pre.hasAttribute("dir")).toBe(false);
    expect(pre.querySelector("code")!.hasAttribute("dir")).toBe(false);
  });

  it("user bubble markdown gets the same per-block dir=auto", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "- قائمة\n- عناصر" });

    const lis = doc.querySelectorAll(".msg.user .body li");
    expect(lis.length).toBe(2);
    for (const li of lis) expect(li.getAttribute("dir")).toBe("auto");
  });

  it("plan card body and its feedback textarea are direction-aware", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "exitPlanRequest",
      req: { id: 5, plan: "1. خطوة أولى\n2. خطوة ثانية" },
    });

    const card = doc.querySelector(".card.plan")!;
    const lis = card.querySelectorAll(".plan-body li");
    expect(lis.length).toBe(2);
    for (const li of lis) expect(li.getAttribute("dir")).toBe("auto");
    expect(card.querySelector(".plan-body ol")!.getAttribute("dir")).toBe("auto");
    expect(card.querySelector("textarea.plan-feedback")!.getAttribute("dir")).toBe("auto");
  });

  it("restored plan-history body (no plan file) gets dir=auto too", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "planHistory", text: "- بند محفوظ", verdict: "approved" });

    const li = doc.querySelector(".card.plan-history .plan-body li")!;
    expect(li).not.toBeNull();
    expect(li.getAttribute("dir")).toBe("auto");
  });
});
