import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgySkills } from "../src/agy-skills";

describe("Antigravity skill discovery", () => {
  let root: string;
  let home: string;
  let project: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "agy-skills-"));
    home = path.join(root, "gemini-home");
    project = path.join(root, "project");
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function skill(base: string, folder: string, text: string): Promise<string> {
    const directory = path.join(base, folder);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "SKILL.md");
    await fs.writeFile(file, text);
    return file;
  }

  it("reads both user roots and both project roots, skips bad files, and keeps one row per name", async () => {
    const config = path.join(home, "config", "skills");
    const cli = path.join(home, "antigravity-cli", "skills");
    const agents = path.join(project, ".agents", "skills");
    const gemini = path.join(project, ".gemini", "skills");
    const global = await skill(config, "folder", "---\r\nname: reviewer\r\ndescription: >-\r\n  Review code\r\n  before merging.\r\n---\r\nPrivate instructions");
    await skill(cli, "cli-check", "---\ndescription: 'CLI check'\n---\n");
    await skill(gemini, "gemini-check", "---\nname: gemini-check\ndescription: Project Gemini skill\n---\n");
    await skill(agents, "project-check", "---\nname: project-check\ndescription: Project skill\n---\n");
    await skill(agents, "reviewer", "---\nname: reviewer\ndescription: A duplicate\n---\n");
    await skill(agents, "broken", "---\nname: [\ndescription: malformed YAML\n---\n");
    await skill(agents, "logout", "---\nname: logout\ndescription: Reserved\n---\n");
    await skill(agents, "large", `---\nname: large\ndescription: Large file\n---\n${"x".repeat(1_000_000)}`);
    await skill(agents, "long-header", `---\nname: long-header\ndescription: ${"x".repeat(17_000)}\n---\n`);
    const results = await discoverAgySkills(project, home);
    expect(results.map(({ name, description, _meta }) => [name, description, _meta?.scope])).toEqual([
      ["reviewer", "Review code before merging.", "user"], ["gemini-check", "Project Gemini skill", "project"],
      ["cli-check", "CLI check", "user"], ["project-check", "Project skill", "project"],
    ]);
    expect(results[0]._meta?.path).toBe(global);
  });

  it("bounds the total number of menu items", async () => {
    for (let index = 0; index < 130; index++) {
      await skill(path.join(project, ".agents", "skills"), `skill-${index}`, "---\ndescription: A skill\n---\n");
    }
    expect(await discoverAgySkills(project, home)).toHaveLength(100);
  });
});
