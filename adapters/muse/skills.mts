import type { AvailableCommand } from "@agentclientprotocol/sdk";

const MAX_SKILLS = 200;
const MAX_SELECTOR_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 300;
const SELECTOR = /^[a-z0-9][\w.:-]*$/i;
const RESERVED = new Set(["compact", "context-window", "context", "always-approve"]);

export function museSkillCommands(rows: unknown): AvailableCommand[] {
  if (!Array.isArray(rows)) throw new Error("Muse skill/list returned no catalog");
  const commands = new Map<string, AvailableCommand>();
  for (const row of rows) {
    const { selector, description } = row ?? {};
    if (typeof selector !== "string" || selector.length > MAX_SELECTOR_LENGTH || !SELECTOR.test(selector)
      || RESERVED.has(selector.toLowerCase()) || commands.has(selector) || typeof description !== "string") continue;
    commands.set(selector, { name: selector, description: description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      _meta: { "muse/skill": true } });
    if (commands.size === MAX_SKILLS) break;
  }
  return [...commands.values()];
}

export function museSkillInput(text: string, selectors: ReadonlySet<string>) {
  const match = /^\/([a-z0-9][\w.:-]*)(?:\s|$)/i.exec(text);
  if (!match || !selectors.has(match[1])) return;
  const args = text.slice(match[0].length).trim();
  return { type: "skill" as const, selector: match[1], ...(args ? { arguments: args } : {}) };
}
