import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_GOAL_COMMANDS, discoverDeepSeekSkills, rewriteDeepSeekPrompt } from "../src/deepseek-commands";
import { DeepSeekBackend } from "../src/deepseek-backend";
import { isAdvertisedSkill } from "../src/slash-filter";

// An ES module namespace cannot be spied on directly; a pass-through mock can.
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs/promises")>()) }));

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-skills-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function put(relative: string, name: string, extra = "", description = "Skill description") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\nInstructions`);
  return fs.realpathSync(file);
}
const discover = () => discoverDeepSeekSkills(path.join(root, "project/sub"), path.join(root, "managed"), path.join(root, "agents"));

describe("dsh filesystem skill catalog", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, "project/sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "project/.git"), "gitdir: elsewhere");
  });
  it("uses ranked roots, frontmatter names, flat files, bundle paths and descriptions", async () => {
    const winner = put("project/.dsh/skills/bundle/SKILL.md", "same", "", '"Project: preferred"');
    put("project/.agents/skills/other.md", "same");
    put("managed/skills/other.md", "same");
    put("agents/skills/other.md", "same");
    put("project/.agents/skills/a.md", "project-agents");
    put("managed/skills/b.md", "managed-skill");
    put("agents/skills/c.md", "shared-skill");
    put("project/.dsh/skills/too/deep/SKILL.md", "nested");
    put("managed/skills/.system/SKILL.md", "system-skill");
    const skills = await discover();
    expect(skills.map(s => s.name)).toEqual(["managed-skill", "project-agents", "same", "shared-skill"]);
    expect(skills.find(s => s.name === "same")).toEqual({ name: "same", description: "Project: preferred", _meta: { path: winner, scope: "project-dsh" } });
    expect(skills.every(isAdvertisedSkill)).toBe(true);
  });
  it("resolves all duplicate ranks, including hidden higher-rank winners and reserved goals", async () => {
    put("project/.agents/skills/a.md", "second"); put("managed/skills/a.md", "second");
    put("managed/skills/b.md", "third"); put("agents/skills/b.md", "third");
    put("project/.dsh/skills/hidden.md", "hidden", 'user-invocable: "OFF"\n');
    put("agents/skills/hidden.md", "hidden");
    for (const command of DEEPSEEK_GOAL_COMMANDS) put(`project/.dsh/skills/${command.name}.md`, command.name);
    const skills = await discover();
    expect(skills.map(s => [s.name, s._meta?.scope])).toEqual([["second", "project-agents"], ["third", "user-dsh"]]);
  });
  it("parses folded YAML and strict invocation flags; skips invalid metadata", async () => {
    put("project/.dsh/skills/folded.md", "folded", "", '>\n  Folded skill\n  description');
    for (const value of ['false', '0', '"no"', '"OFF"']) put(`agents/skills/hidden-${value.replace(/\W/g, "")}.md`, `hidden-${value.replace(/\W/g, "").toLowerCase()}`, `user-invocable: ${value}\n`);
    put("agents/skills/invalid.md", "invalid", "user-invocable: perhaps\n");
    put("agents/skills/legacy.md", "legacy", "userInvocable: true\n");
    put("agents/skills/model-disabled.md", "model-disabled", "disable-model-invocation: yes\n");
    put("agents/skills/camel.md", "CamelCase");
    put("agents/skills/no-description.md", "no-description", "", "");
    put("agents/skills/bad-yaml.md", "bad-yaml", "description: [unterminated\n");
    fs.writeFileSync(path.join(root, "agents/skills/missing.md"), "no frontmatter");
    expect(await discover()).toEqual([expect.objectContaining({ name: "folded", description: "Folded skill description\n" })]);
  });
  it("uses the nearest git ancestor, or cwd when none exists", async () => {
    put("project/.dsh/skills/outer.md", "outer");
    fs.mkdirSync(path.join(root, "project/sub/.git"));
    put("project/sub/.dsh/skills/inner.md", "inner");
    expect((await discover()).map(s => s.name)).toEqual(["inner"]);
    fs.rmSync(path.join(root, "project/.git")); fs.rmSync(path.join(root, "project/sub/.git"), { recursive: true });
    expect((await discover()).map(s => s.name)).toEqual(["inner"]);
  });
  it("resolves symlinked bundles to their instruction file", async () => {
    const target = put("external/SKILL.md", "linked");
    const link = path.join(root, "project/.dsh/skills/link");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.dirname(target), link, "junction");
    expect(await discover()).toEqual([expect.objectContaining({ name: "linked", _meta: { path: target, scope: "project-dsh" } })]);
  });
  it.each(["readdir", "readFile", "realpath", "stat"] as const)("keeps goals and the last good skills after an asynchronous %s failure", async method => {
    put("project/.dsh/skills/a.md", "available");
    const backend = new DeepSeekBackend({ storageRoot: root, platform: "linux" });
    backend.spawn({ cliPath: root, cwd: root, env: { DSH_AGENTS_HOME: path.join(root, "agents") } });
    const cwd = path.join(root, "project/sub"), log = vi.fn();
    const previous = await backend.availableCommands(cwd, log);
    expect(previous.some(c => c.name === "available")).toBe(true);
    vi.spyOn(fsp, method).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(await backend.availableCommands(cwd, log)).toEqual(previous);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("denied"));
  });
});

describe("DeepSeek instruction shortcuts", () => {
  const skill = { name: "review", description: "Review code", _meta: { path: "/review.md", scope: "project-dsh" } };
  const commands = [...DEEPSEEK_GOAL_COMMANDS, skill];
  it.each([
    ["/goal make it work", "Set a session goal with create_goal. Objective: make it work. Then start working on it."],
    ["/goal-status", "Call get_goal and tell me the current goal and its status. Do nothing else."],
    ["/goal-pause", 'action "pause". Do nothing else.'],
    ["/goal-resume", 'action "resume", then continue working on it.'],
    ["/goal-done", 'action "complete". Do nothing else.'],
    ["/review this patch", "Use the `review` skill: load it with the skill tool and follow it. this patch"],
    ["Please /review this patch", "Please Use the `review` skill: load it with the skill tool and follow it. this patch"],
  ])("rewrites %s using verified tool names", (text, expected) => {
    expect(rewriteDeepSeekPrompt(text, commands)).toContain(expected);
  });
  it.each(["/goal", "/goal \n\t"])("asks for the objective of an empty goal rather than refusing it (%s)", text => {
    expect(rewriteDeepSeekPrompt(text, commands)).toBe(
      "I want to set a session goal. Ask me what its objective should be, then set it with create_goal. Do nothing else until I answer.");
  });
  it.each([
    ["/goal-status and say what is blocking it", "Call get_goal and tell me the current goal and its status. and say what is blocking it"],
    ["/goal-pause until the review lands", 'action "pause". until the review lands'],
    ["/goal-done we shipped it", 'action "complete". we shipped it'],
  ])("keeps the words after %s", (text, expected) => {
    const out = rewriteDeepSeekPrompt(text, commands);
    expect(out).toContain(expected);
    expect(out).not.toContain("Do nothing else");
  });
  it.each(["/unknown hello", "Please /goal work", "/goal/path", "docs/review", "/review-more", "/compact"])("preserves ordinary text (%s)", text => {
    expect(rewriteDeepSeekPrompt(text, commands)).toBe(text);
  });
  it("does not rewrite shortcuts without their advertisement", () => {
    expect(rewriteDeepSeekPrompt("/goal hello", [])).toBe("/goal hello");
    expect(rewriteDeepSeekPrompt("/review hello", [])).toBe("/review hello");
  });
});
