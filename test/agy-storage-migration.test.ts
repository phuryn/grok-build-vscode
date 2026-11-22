import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeRetiredAgyInstall } from "../src/agy-storage-migration";

describe("retired Antigravity download", () => {
  let root: string;
  let storage: string;
  let gemini: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "agy-migration-")));
    storage = path.join(root, "afk");
    gemini = path.join(root, ".gemini");
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  const install = async (location: string, name = "1.5.2") => {
    const dir = path.join(location, "agy-managed", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "agy_acp_server.exe"), "binary");
    await fs.writeFile(path.join(dir, "localharness_external.exe"), "harness");
    return dir;
  };

  it("removes the managed copy once, preserving configured, unrecognized and Gemini paths", async () => {
    const owned = await install(storage);
    const configured = await install(storage, "1.4.0");
    const uncertain = await install(storage, "1.3.0");
    const unrelated = await install(root);
    const userHome = await install(gemini);
    await fs.writeFile(path.join(uncertain, "user-file.txt"), "keep");
    await fs.writeFile(path.join(storage, "other"), "keep");
    for (let attempt = 0; attempt < 2; attempt++) {
      await removeRetiredAgyInstall(storage, [path.join(configured, "agy_acp_server.exe")], [gemini]);
    }
    await removeRetiredAgyInstall(gemini, [], [gemini]);
    await expect(fs.stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    for (const dir of [configured, uncertain, unrelated, userHome]) {
      expect(await fs.readFile(path.join(dir, "agy_acp_server.exe"), "utf8")).toBe("binary");
    }
    expect(await fs.readFile(path.join(storage, "other"), "utf8")).toBe("keep");
  });

  it("does not follow a linked managed root or version directory", async () => {
    const outside = await install(gemini);
    await fs.mkdir(storage);
    const link = path.join(storage, "agy-managed");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(path.dirname(outside), link, linkType);
    await removeRetiredAgyInstall(storage, [], [gemini]);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    await fs.unlink(link);
    await fs.mkdir(link);
    const versionLink = path.join(link, "1.5.2");
    await fs.symlink(outside, versionLink, linkType);
    await removeRetiredAgyInstall(storage, [], [gemini]);
    expect((await fs.lstat(versionLink)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(outside, "agy_acp_server.exe"), "utf8")).toBe("binary");
  });
});
