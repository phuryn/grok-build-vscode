import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { codexManagedBinaryPath, codexManagedRelease, codexManagedRoot, installManagedCodex } from "../src/codex-managed-installer";
import { claimManagedCodexUpgrade, updateManagedCodexOnUpgrade } from "../src/codex-managed-upgrade";

const roots: string[] = [];
const floor = codexManagedRelease()!;
const latest = {
  ...floor, tag: "rust-v0.171.0", version: "0.171.0",
  url: floor.url.replace(floor.tag, "rust-v0.171.0"),
};

async function harness(installedTag = floor.tag) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "afk-codex-upgrade-test-"));
  roots.push(storageRoot);
  const binary = codexManagedBinaryPath(storageRoot, process.platform, installedTag);
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, "installed");
  return {
    storageRoot, binary, afkVersion: "4.18.0", signal: new AbortController().signal,
    onRelease: vi.fn(), log: vi.fn(),
    resolve: vi.fn(async () => latest),
    install: vi.fn(async () => codexManagedBinaryPath(storageRoot, process.platform, latest.tag)),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("claims one attempt per AFK version across concurrent callers and claims again after an upgrade", async () => {
  const h = await harness();
  const expected = codexManagedBinaryPath(h.storageRoot, process.platform, latest.tag);
  expect(await Promise.all([updateManagedCodexOnUpgrade(h), updateManagedCodexOnUpgrade(h)]))
    .toEqual(expect.arrayContaining([expected, undefined]));
  expect(h.resolve).toHaveBeenCalledOnce();
  expect(h.onRelease).toHaveBeenCalledWith(latest);
  expect(h.install).toHaveBeenCalledOnce();
  expect(h.install).toHaveBeenCalledWith(expect.objectContaining({ release: latest, keepBinary: h.binary }));
  await expect(updateManagedCodexOnUpgrade(h)).resolves.toBeUndefined();
  expect(h.resolve).toHaveBeenCalledOnce();
  await expect(updateManagedCodexOnUpgrade({ ...h, afkVersion: "4.19.0" })).resolves.toBe(expected);
  expect(h.resolve).toHaveBeenCalledTimes(2);
});

it("counts a fresh install as the current AFK version's lookup", async () => {
  const h = await harness();
  await claimManagedCodexUpgrade(h.storageRoot, h.afkVersion);
  await expect(updateManagedCodexOnUpgrade(h)).resolves.toBeUndefined();
  expect(h.resolve).not.toHaveBeenCalled();
});

it("skips lookup and installation for a user-owned executable", async () => {
  const h = await harness();
  const ownBinary = path.join(h.storageRoot, "user", path.basename(h.binary));
  await fs.mkdir(path.dirname(ownBinary));
  await fs.writeFile(ownBinary, "user copy");
  await expect(updateManagedCodexOnUpgrade({ ...h, binary: ownBinary })).resolves.toBeUndefined();
  expect(h.resolve).not.toHaveBeenCalled();
  expect(h.install).not.toHaveBeenCalled();
  expect(await fs.readFile(ownBinary, "utf8")).toBe("user copy");
  await updateManagedCodexOnUpgrade(h);
  expect(h.resolve).toHaveBeenCalledOnce();
});

it("compares numeric versions and never installs an older release", async () => {
  const h = await harness("rust-v0.171.0");
  h.resolve.mockResolvedValue({ ...latest, tag: "rust-v0.99.0", version: "0.99.0" });
  await expect(updateManagedCodexOnUpgrade(h)).resolves.toBeUndefined();
  expect(h.resolve).toHaveBeenCalledOnce();
  expect(h.install).not.toHaveBeenCalled();
});

it("aborts a stalled download at its deadline and logs the failure", async () => {
  const h = await harness();
  const downloadSignal = new AbortController();
  const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(downloadSignal.signal);
  const install = vi.fn(({ signal }: Parameters<typeof installManagedCodex>[0]) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      downloadSignal.abort(new Error("deadline reached"));
    }));
  try {
    await expect(updateManagedCodexOnUpgrade({ ...h, install })).resolves.toBeUndefined();
    expect(deadline).toHaveBeenCalledWith(900_000);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("deadline reached"));
    expect(await fs.readFile(h.binary, "utf8")).toBe("installed");
  } finally { deadline.mockRestore(); }
});

it("logs a failed install, keeps the working binary and spends the attempt", async () => {
  const h = await harness();
  const install = vi.fn((options: Parameters<typeof installManagedCodex>[0]) =>
    installManagedCodex({ ...options, download: async (_url, destination) => {
      await fs.writeFile(destination, "partial");
      throw new Error("connection dropped");
    } }));
  await expect(updateManagedCodexOnUpgrade({ ...h, install })).resolves.toBeUndefined();
  expect(h.log).toHaveBeenCalledWith(expect.stringContaining("connection dropped"));
  expect(await fs.readFile(h.binary, "utf8")).toBe("installed");
  expect((await fs.readdir(codexManagedRoot(h.storageRoot))).sort()).toEqual([
    ".afk-update-4.18.0", floor.tag,
  ]);
  await updateManagedCodexOnUpgrade({ ...h, install });
  expect(install).toHaveBeenCalledOnce();
});
