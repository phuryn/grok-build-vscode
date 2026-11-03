import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SlashCommand } from "./acp";
import { isAdvertisedSkill } from "./slash-filter";

const { load, CORE_SCHEMA }: { load: (text: string, options: { schema: unknown }) => unknown; CORE_SCHEMA: unknown } = require("js-yaml");

export const DEEPSEEK_GOAL_COMMANDS: SlashCommand[] = [
  { name: "goal", input: { hint: "what to achieve" }, description: "Ask DeepSeek to set a goal for this session and keep working until it's done." },
  { name: "goal-status", description: "Ask DeepSeek for the current goal and its progress." },
  { name: "goal-pause", description: "Ask DeepSeek to pause the goal." },
  { name: "goal-resume", description: "Ask DeepSeek to resume a paused goal." },
  { name: "goal-done", description: "Ask DeepSeek to mark the goal complete." },
];
const goalNames = new Set(DEEPSEEK_GOAL_COMMANDS.map(c => c.name));
export const DEEPSEEK_GOAL_OBJECTIVE_NOTICE = "Add an objective: /goal what to achieve.";
export function deepseekPromptNotice(text: string): string | undefined {
  return /^\/goal\s*$/.test(text) ? DEEPSEEK_GOAL_OBJECTIVE_NOTICE : undefined;
}

function absent(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function invocationBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  const raw = data[key];
  if (typeof raw !== "boolean" && typeof raw !== "number" && typeof raw !== "string") throw new Error(`Invalid ${key}`);
  const value = String(raw).toLowerCase();
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  throw new Error(`Invalid ${key}`);
}

function skillMetadata(text: string): { name: string; description: string; visible: boolean } | undefined {
  const match = /^---\r?\n([\s\S]*?)^---\r?$(?:\n|$)/m.exec(text);
  if (!match || match.index !== 0) return;
  const data = load(match[1], { schema: CORE_SCHEMA }) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  if (typeof data.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)
    || typeof data.description !== "string" || !data.description.length) return;
  if (["disableModelInvocation", "modelInvocable", "userInvocable"].some(key => Object.hasOwn(data, key))) return;
  const user = invocationBoolean(data, "user-invocable");
  const disabled = invocationBoolean(data, "disable-model-invocation");
  // These shortcuts load through the model-facing skill tool, which refuses
  // disable-model-invocation skills even when their native human gesture works.
  return { name: data.name, description: data.description, visible: user !== false && disabled !== true };
}

/** The four default filesystem roots in dsh 0.2.1-rc.5 rank order. */
export async function discoverDeepSeekSkills(cwd: string, dshHome: string, agentsHome: string): Promise<SlashCommand[]> {
  let projectRoot = path.resolve(cwd);
  while (true) {
    try { await fs.stat(path.join(projectRoot, ".git")); break; }
    catch (error) { if (!absent(error)) throw error; }
    const parent = path.dirname(projectRoot);
    if (parent === projectRoot) { projectRoot = path.resolve(cwd); break; }
    projectRoot = parent;
  }
  const roots = [
    { dir: path.join(projectRoot, ".dsh/skills"), scope: "project-dsh" },
    { dir: path.join(projectRoot, ".agents/skills"), scope: "project-agents" },
    { dir: path.join(dshHome, "skills"), scope: "user-dsh" },
    { dir: path.join(agentsHome, "skills"), scope: "user-agents" },
  ];
  const seen = new Set(goalNames);
  const skills: SlashCommand[] = [];
  for (const root of roots) {
    let entries;
    try { entries = await fs.readdir(root.dir, { withFileTypes: true }); }
    catch (error) { if (absent(error)) continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (root.scope === "user-dsh" && entry.name === ".system") continue;
      const entryPath = path.join(root.dir, entry.name);
      let info;
      try { info = entry.isSymbolicLink() ? await fs.stat(entryPath) : entry; }
      catch (error) { if (absent(error)) continue; throw error; }
      const file = info.isDirectory() ? path.join(entryPath, "SKILL.md")
        : info.isFile() && entry.name.endsWith(".md") ? entryPath : undefined;
      if (!file) continue;
      let text: string, resolved: string;
      try {
        if (!(await fs.stat(file)).isFile()) continue;
        resolved = await fs.realpath(file);
        text = await fs.readFile(resolved, "utf8");
      } catch (error) { if (absent(error)) continue; throw error; }
      let skill;
      try { skill = skillMetadata(text); } catch { continue; }
      if (!skill || seen.has(skill.name)) continue;
      // Resolve precedence before visibility: a hidden project skill must not
      // expose a lower-ranked copy that dsh would never load.
      seen.add(skill.name);
      if (skill.visible) skills.push({ name: skill.name, description: skill.description, _meta: { path: resolved, scope: root.scope } });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Expand only authored slash tokens in the final outbound copy. */
export function rewriteDeepSeekPrompt(text: string, commands: readonly SlashCommand[]): string {
  const goal = /^\/(goal(?:-status|-pause|-resume|-done)?)(?=\s|$)/.exec(text);
  if (goal && commands.some(c => c.name === goal[1] && !isAdvertisedSkill(c))) {
    const rest = text.slice(goal[0].length).trim();
    switch (goal[1]) {
      case "goal":
        if (!rest) throw new Error(DEEPSEEK_GOAL_OBJECTIVE_NOTICE);
        return `Set a session goal with create_goal. Objective: ${rest}. Then start working on it.`;
      case "goal-status": return "Call get_goal and tell me the current goal and its status. Do nothing else.";
      case "goal-pause": return 'This is my direct request: call get_goal for the current goal_id and revision, then pause the current session goal with update_goal using those values and action "pause". Do nothing else.';
      case "goal-resume": return 'This is my direct request: call get_goal for the current goal_id and revision, then resume the current session goal with update_goal using those values and action "resume", then continue working on it.';
      case "goal-done": return 'Call get_goal for the current goal_id and revision, then mark the current session goal complete with update_goal using those values and action "complete". Do nothing else.';
    }
  }
  const skills = new Set(commands.filter(isAdvertisedSkill).map(c => c.name));
  return text.replace(/(^|[ \t\r\n\f\v])\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=[ \t\r\n\f\v]|$)/g,
    (token, boundary: string, name: string) => skills.has(name)
      ? `${boundary}Use the \`${name}\` skill: load it with the skill tool and follow it.` : token);
}
