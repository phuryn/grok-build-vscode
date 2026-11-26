import type { StateFs } from "./persisted-state";
import { isRoutineRun, type SessionMetaOverrides } from "./sessions";

export const STAR_PROMPT_DELAY_MS = 30_000;
export const STAR_PROMPT_REPEAT_MS = 30 * 24 * 60 * 60 * 1000;
const STAR_PROMPT_MIN_CONVERSATIONS = 5;
const STAR_PROMPT_FILE = "star-prompt.json";

/** "due": never asked, or last asked 30 days ago and not answered with Star or Open GitHub. */
export type StarPromptState = "due" | "asked" | "unavailable";

/** When the card was last shown; `done` once the person chose Star or Open GitHub. */
type StoredStarPrompt = { askedAt: number; done?: true };

export function countStarPromptConversations(meta: SessionMetaOverrides): number {
  return Object.values(meta).filter(row => typeof row?.sentAt === "number" && !isRoutineRun(row)).length;
}

export function mayAskForStar(state: StarPromptState, readMeta: () => SessionMetaOverrides): boolean {
  return state === "due" && countStarPromptConversations(readMeta()) >= STAR_PROMPT_MIN_CONVERSATIONS;
}

function parseStored(text: string): StoredStarPrompt | null {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { askedAt, done } = value as Record<string, unknown>;
  if (typeof askedAt !== "number" || !Number.isFinite(askedAt) || (done !== undefined && done !== true)) return null;
  return done ? { askedAt, done } : { askedAt };
}

function stateOf(stored: StoredStarPrompt | null | undefined, now: number): StarPromptState {
  if (stored === null) return "unavailable";
  return !stored || (!stored.done && now - stored.askedAt >= STAR_PROMPT_REPEAT_MS) ? "due" : "asked";
}

/** When this person was asked. Read from disk every time: another window may have asked since. */
export class StarPromptRecord {
  constructor(
    private readonly dir: string,
    private readonly fs: Pick<StateFs, "readFileSync" | "writeFileSync" | "mkdirSync">,
  ) {}

  private get file(): string {
    return `${this.dir}/${STAR_PROMPT_FILE}`;
  }

  /** undefined: never asked. null: a record that cannot be read, so the card is never shown. */
  private read(): StoredStarPrompt | null | undefined {
    try {
      return parseStored(this.fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
    }
  }

  state(now = Date.now()): StarPromptState {
    return stateOf(this.read(), now);
  }

  /** True for the window that may show the card now. The first ask creates the file, so only one window wins it. */
  claim(now = Date.now()): boolean {
    const stored = this.read();
    if (stateOf(stored, now) !== "due") return false;
    return this.write({ askedAt: now }, stored ? "w" : "wx");
  }

  /** After Star or Open GitHub the card never comes back. */
  finish(askedAt: number): void {
    this.write({ askedAt, done: true }, "w");
  }

  private write(record: StoredStarPrompt, flag: "w" | "wx"): boolean {
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(this.file, JSON.stringify(record), { encoding: "utf8", flag });
      return true;
    } catch {
      return false;
    }
  }
}
