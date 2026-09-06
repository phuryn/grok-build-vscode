import { isImageChip, isImplicitChip, type FileChip } from "./chips";
import type { PromptContentBlock } from "./acp";
import { STAGED_IMAGE_TAG_HINT, WORKSPACE_IMAGE_TAG_HINT } from "./image-history";

export interface PromptBuilderDeps {
  readFile: (path: string) => string;
  extName: (path: string) => string;
}

/** One attached image, pre-read by the host (the builder never touches the
 *  filesystem — an unreadable image must block the send in the host, not be
 *  silently skipped here). */
export interface PromptImageInput {
  index: number;
  mimeType: string;
  /** base64 payload */
  data: string;
  /** Staged source path, retained so restored history can find the thumbnail. */
  path?: string;
  /** Workspace-relative origin path for images imported from disk — carried in
   *  the tag (`[Image #N] (assets/x.png — attached inline; …)`) so grok keeps
   *  the file's identity. */
  relPath?: string;
}

function imageBasename(p: string): string {
  return p.trim().split(/[\\/]/).pop() || p.trim();
}

// The file-path context (attached files + the open-editor file) is wrapped in a
// unique, machine-readable tag so it can be parsed back deterministically on
// session restore (to re-render filename-only chips instead of the raw prompt
// text) — see `parseAttachmentContext` in media/webview-helpers.js. The inner
// wording is deliberately the same natural prose grok already reads well; the tag
// is just an unambiguous envelope. The `note` tells grok it's editor-injected.
export const CONTEXT_TAG_OPEN =
  '<vscode-context note="added by the editor, not typed by the user">';
export const CONTEXT_TAG_CLOSE = "</vscode-context>";

/**
 * Where a selection stops being embedded and becomes a reference.
 *
 * The active-editor chip is not a one-shot attachment: `consumeChips` keeps it
 * across sends, so a selection is re-read from disk and re-embedded on EVERY
 * message of the conversation. Selecting a whole large file therefore sent that
 * file again with every turn. Past these bounds the range is named instead —
 * the agent has the path and can read exactly those lines if it wants them.
 */
export const MAX_SELECTION_LINES = 400;
export const MAX_SELECTION_CHARS = 20_000;

/**
 * Build the final prompt text from a typed message + active chips.
 *
 * - Hidden chips are skipped.
 * - A chip with a selection range becomes a fenced code block of those lines.
 * - A chip without a range becomes a bare path — NOT an `@`-reference. `@` is grok's
 *   "read this whole file" convention, which slurps a large file into context (a big
 *   CSV/log) and fails outright on binaries. Handing grok the plain path lets it
 *   choose how to consume each: grep/range-read big text, pass a video path to its
 *   media tools, read a small file in full. Raster images (png/jpg/gif/webp) are
 *   split off UPSTREAM (addDroppedFile → makeImageChip) and ride the inline-vision
 *   blocks in buildPromptWithImages instead — what reaches this path list is text,
 *   SVG (kept editable on purpose), videos, and oversized images.
 * - Whole-file chips are split by origin: a file the user explicitly attached is the
 *   strong "act on this" signal ("Attached file(s)"), while the active-editor file
 *   auto-included for ambient context is the weaker "this is what I'm looking at"
 *   signal ("Currently open in the editor (for context)"). Keeping them apart stops
 *   grok treating a file you happen to have open as one you asked it to work on.
 * - The user's text follows after a blank line — EXCEPT for confirmed slash
 *   commands (`slashCommand: true`), where the order flips and the context
 *   trails the text instead. The CLI dispatches a slash command only when it
 *   sits at position 0 of the text block; a leading envelope silently degrades
 *   `/compact` into an ordinary LLM turn that ballooned context 6x in testing
 *   (research/compact-probe.cjs, grok 0.2.87 — trailing context verified to
 *   keep native dispatch). Restore still strips a trailing envelope
 *   (parseAttachmentContext matches anywhere), but selection snippets are only
 *   peeled from the body's start, so a slash+selection send replays its
 *   snippet inline — acceptable for that rare combination.
 */
export function buildPrompt(
  text: string,
  chips: FileChip[],
  deps: PromptBuilderDeps,
  slashCommand = false,
): string {
  const attached: string[] = []; // explicitly attached whole files → bare paths, grok decides how to read
  const openInEditor: string[] = []; // implicit active-editor file → ambient context only
  const blocks: string[] = []; // selection-range chips (explicit or the live editor selection) → fenced snippet of exactly those lines
  for (const chip of chips) {
    if (chip.hidden) continue;
    if (chip.selectionStart && chip.selectionEnd) {
      let content: string;
      try {
        content = deps.readFile(chip.path);
      } catch {
        attached.push(chip.relPath); // couldn't read the range — fall back to a plain path
        continue;
      }
      const lines = content
        .split("\n")
        .slice(chip.selectionStart - 1, chip.selectionEnd);
      const snippet = lines.join("\n");
      if (lines.length > MAX_SELECTION_LINES || snippet.length > MAX_SELECTION_CHARS) {
        // Too big to repeat every turn — name the range in the bucket the chip
        // belongs to, so an ambient editor selection still reads as ambient and
        // an attached one still reads as "act on this".
        const ref = `${chip.relPath} (lines ${chip.selectionStart}-${chip.selectionEnd})`;
        if (isImplicitChip(chip)) openInEditor.push(ref);
        else attached.push(ref);
        continue;
      }
      const ext = deps.extName(chip.path).replace(/^\./, "");
      blocks.push(
        `\`${chip.relPath}\` (lines ${chip.selectionStart}-${chip.selectionEnd}):\n\`\`\`${ext}\n${snippet}\n\`\`\``,
      );
    } else if (isImplicitChip(chip)) {
      openInEditor.push(chip.relPath);
    } else {
      attached.push(chip.relPath);
    }
  }

  const contextSections: string[] = [];
  if (attached.length === 1) {
    contextSections.push(`Attached file: ${attached[0]}`);
  } else if (attached.length > 1) {
    contextSections.push("Attached files:\n" + attached.map((f) => `- ${f}`).join("\n"));
  }
  if (openInEditor.length === 1) {
    contextSections.push(`Currently open in the editor (for context): ${openInEditor[0]}`);
  } else if (openInEditor.length > 1) {
    contextSections.push(
      "Currently open in the editor (for context):\n" +
        openInEditor.map((f) => `- ${f}`).join("\n"),
    );
  }

  const context: string[] = [];
  if (contextSections.length) {
    context.push(`${CONTEXT_TAG_OPEN}\n${contextSections.join("\n\n")}\n${CONTEXT_TAG_CLOSE}`);
  }
  context.push(...blocks);
  const parts = slashCommand ? [text, ...context] : [...context, text];
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Build the ACP prompt payload for a user turn: one text block (file context +
 * typed message + `[Image #N]` tags) followed by an image content block per
 * attached image (base64 inline — verified accepted by grok 0.2.87 despite the
 * advertised `promptCapabilities.image:false`; see research/vision-input.md).
 *
 * Shape invariants:
 * - No images → the text is byte-identical to `buildPrompt(text, chips)`, so
 *   the restore parser (`parseAttachmentContext`) sees the exact legacy wire.
 * - With images → `<envelope>\n\n<text>\n\n<tags>`: the user's text stays at
 *   the start of its own section (a leading tag would knock a `/command` off
 *   position 0 and break CLI slash dispatch), and each tag sits on its own
 *   trailing line, carrying the origin workspace path when there is one so
 *   grok can act on the real file, not just the pixels.
 * - Every tag's parenthetical carries a do-not-Read hint: the CLI keeps its
 *   own copy of an inline image under the session's `assets/` dir and surfaces
 *   that path to the model, which then tries `Read` on the binary and fails —
 *   a noisy no-op on every pasted image (observed in Windows dogfooding,
 *   2026-07-09). The hint kills the temptation at the point of use instead of
 *   burdening global instructions; see research/vision-input.md.
 * - Confirmed slash commands (`slashCommand: true`) flip the envelope too:
 *   `<text>\n\n<envelope>\n\n<tags>` — the same position-0 rule the tag
 *   placement already honors also applies to the envelope itself (that was
 *   the missed half: a leading envelope broke dispatch exactly like a
 *   leading tag would). Tags stay trailing in both orders, so
 *   `parseImageTags`'s strip-from-the-end assumption holds.
 * - `blocks[0]` is always the text block; image blocks follow in tag order.
 *   The restore side parses tags back out via `parseImageTags` in
 *   media/webview-helpers.js — keep the tag format in sync with it.
 */
export function buildPromptWithImages(
  text: string,
  chips: FileChip[],
  images: PromptImageInput[],
  deps: PromptBuilderDeps,
  slashCommand = false,
): { text: string; blocks: PromptContentBlock[] } {
  const fileChips = chips.filter((c) => !isImageChip(c));
  if (images.length === 0) {
    const plain = buildPrompt(text, fileChips, deps, slashCommand);
    return { text: plain, blocks: [{ type: "text", text: plain }] };
  }
  const sorted = [...images].sort((a, b) => a.index - b.index);
  const tagLines = sorted
    .map((im) => im.relPath
      ? `[Image #${im.index}] (${im.relPath} — ${WORKSPACE_IMAGE_TAG_HINT})`
      : im.path
        ? `[Image #${im.index}] (${imageBasename(im.path)} — ${STAGED_IMAGE_TAG_HINT})`
        : `[Image #${im.index}] (attached inline — already visible to you; do not read it from disk)`)
    .join("\n");
  const filePrompt = buildPrompt("", fileChips, deps);
  const ordered = slashCommand ? [text, filePrompt, tagLines] : [filePrompt, text, tagLines];
  const promptText = ordered.filter(Boolean).join("\n\n");
  const blocks: PromptContentBlock[] = [{ type: "text", text: promptText }];
  for (const im of sorted) {
    blocks.push({ type: "image", mimeType: im.mimeType, data: im.data, ...(im.path ? { path: im.path } : {}) });
  }
  return { text: promptText, blocks };
}

/**
 * One queued contribution's prompt ingredients. Image indices are the numbers
 * stamped at attach — never rewritten. The combined builder copies `text`
 * verbatim and emits tags from those indices.
 */
export interface QueuedPromptContribution {
  text: string;
  chips: FileChip[];
  images: PromptImageInput[];
}

/**
 * Build one `session/prompt` from discrete queued contributions, each keeping
 * its own attachments. Tags sit with the contribution they belong to rather
 * than dumping a union at the end. Numbering is the attach-time index on each
 * chip — gaps survive a prefix flush or a removed contribution, and `text`
 * is copied as authored, never rewritten.
 *
 * Implicit (ambient editor) chips are applied once, on the last contribution,
 * matching a live send's single context envelope.
 */
export function buildQueuedPromptWithImages(
  contributions: QueuedPromptContribution[],
  implicitChips: FileChip[],
  deps: PromptBuilderDeps,
  slashCommand = false,
): { text: string; blocks: PromptContentBlock[] } {
  if (contributions.length === 0) {
    const plain = buildPrompt("", implicitChips, deps, slashCommand);
    return { text: plain, blocks: [{ type: "text", text: plain }] };
  }
  if (contributions.length === 1) {
    const only = contributions[0];
    return buildPromptWithImages(
      only.text,
      [...only.chips, ...implicitChips],
      only.images,
      deps,
      slashCommand,
    );
  }
  const parts: string[] = [];
  const imageBlocks: PromptContentBlock[] = [];
  for (let i = 0; i < contributions.length; i++) {
    const contribution = contributions[i];
    const extraImplicit = i === contributions.length - 1 ? implicitChips : [];
    const built = buildPromptWithImages(
      contribution.text,
      [...contribution.chips, ...extraImplicit],
      contribution.images,
      deps,
      slashCommand && i === 0,
    );
    if (built.text) parts.push(built.text);
    for (const block of built.blocks) {
      if (block.type === "image") imageBlocks.push(block);
    }
  }
  const promptText = parts.join("\n\n");
  return { text: promptText, blocks: [{ type: "text", text: promptText }, ...imageBlocks] };
}
