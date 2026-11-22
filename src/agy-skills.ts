import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SlashCommand } from "./acp";
import { HIDDEN_SLASH_COMMANDS, isAdvertisedSkill } from "./slash-filter";

const { load, CORE_SCHEMA }: { load: (text: string, options: { schema: unknown }) => unknown; CORE_SCHEMA: unknown } = require("js-yaml");

const MAX_ROOT_ENTRIES = 128;
const MAX_SKILLS = 100;
const MAX_FRONTMATTER_BYTES = 16_384;
const MAX_SKILL_BYTES = 1_000_000;
const RESERVED_NAMES = new Set([...HIDDEN_SLASH_COMMANDS, "compact", "context-window", "logout", "plan", "usage"]);

async function readSkill(file: string, folder: string, scope: string): Promise<SlashCommand | undefined> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FRONTMATTER_BYTES));
    const handle = await fs.open(file, "r");
    let bytesRead: number;
    try { ({ bytesRead } = await handle.read(buffer)); }
    finally { await handle.close(); }
    const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(buffer.toString("utf8", 0, bytesRead));
    if (!frontmatter) return;
    const metadata = load(frontmatter[1], { schema: CORE_SCHEMA }) as { name?: unknown; description?: unknown } | undefined;
    const name = metadata?.name ?? folder;
    const description = typeof metadata?.description === "string" ? metadata.description.replace(/\s+/g, " ").trim() : "";
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || !description || RESERVED_NAMES.has(name)) return;
    return { name, description: description.slice(0, 240), _meta: { path: file, scope } };
  } catch { return undefined; }
}

/** The ACP server supplies these four roots to its harness in this order. */
export async function discoverAgySkills(cwd: string, geminiHome: string): Promise<SlashCommand[]> {
  const roots = [
    { dir: path.join(geminiHome, "config", "skills"), scope: "user" },
    { dir: path.join(cwd, ".gemini", "skills"), scope: "project" },
    { dir: path.join(geminiHome, "antigravity-cli", "skills"), scope: "user" },
    { dir: path.join(cwd, ".agents", "skills"), scope: "project" },
  ];
  const skills = new Map<string, SlashCommand>();
  for (const { dir, scope } of roots) {
    const folders: string[] = [];
    try {
      let entries = 0;
      for await (const entry of await fs.opendir(dir)) {
        if (entry.isDirectory() || entry.isSymbolicLink()) folders.push(entry.name);
        if (++entries >= MAX_ROOT_ENTRIES) break;
      }
    } catch { continue; }
    for (const folder of folders.sort()) {
      const skill = await readSkill(path.join(dir, folder, "SKILL.md"), folder, scope);
      if (skill && !skills.has(skill.name)) skills.set(skill.name, skill);
      if (skills.size >= MAX_SKILLS) return [...skills.values()];
    }
  }
  return [...skills.values()];
}

/** ACP parses only built-in slash commands. Ask for the harness's skill by name. */
export function rewriteAgyPrompt(text: string, commands: readonly SlashCommand[]): string {
  const skills = new Set(commands.filter(isAdvertisedSkill).map(command => command.name));
  return text.replace(/(^|[ \t\r\n\f\v])\/([a-z0-9][a-z0-9-]{0,63})(?=[ \t\r\n\f\v]|$)/g,
    (token, boundary: string, name: string) => skills.has(name)
      ? `${boundary}[Use the ${name} skill with lookup_skill and follow its instructions]` : token);
}

/** Restore the slash spelling for earlier turns carried over as text. */
export function restoreAgySkillShortcuts(text: string): string {
  return text.replace(/(^|\s)\[Use the ([a-z0-9][a-z0-9-]{0,63}) skill with lookup_skill and follow its instructions\](?=\s|$)/g, "$1/$2");
}
