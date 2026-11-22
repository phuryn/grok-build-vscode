import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractZipFile } from "../src/zip-extract";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grok-agy-managed-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

type Entry = { name: string; body?: Buffer; method?: 0 | 8; flags?: number; zip64?: boolean };

/** A minimal zip writer: local headers, central directory, end record. */
function zip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.body ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const data = method === 8 && body.length ? deflateRawSync(body) : body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.flags ?? 0, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(entry.zip64 ? 0xffffffff : data.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

describe("zip extraction", () => {
  async function extract(entries: Entry[]): Promise<{ root: string; files: string[] }> {
    const root = await tempRoot();
    const file = path.join(root, "a.zip");
    await fs.promises.writeFile(file, zip(entries));
    const files = await extractZipFile(file, path.join(root, "out"));
    return { root, files };
  }

  it("streams stored and deflated entries, directories and empty files", async () => {
    const { root, files } = await extract([
      { name: "dir/" },
      { name: "dir/stored.txt", body: Buffer.from("stored"), method: 0 },
      { name: "deflated.bin", body: Buffer.alloc(200_000, 7) },
      { name: "empty.txt" },
    ]);
    expect(files.map((file) => path.relative(path.join(root, "out"), file).replace(/\\/g, "/")).sort())
      .toEqual(["deflated.bin", "dir/stored.txt", "empty.txt"]);
    expect(fs.readFileSync(path.join(root, "out", "dir", "stored.txt"), "utf8")).toBe("stored");
    expect(fs.readFileSync(path.join(root, "out", "deflated.bin")).equals(Buffer.alloc(200_000, 7))).toBe(true);
  });

  it("refuses entries that would land outside the destination", async () => {
    await expect(extract([{ name: "../evil.txt", body: Buffer.from("x") }])).rejects.toThrow(/Unsafe/);
    await expect(extract([{ name: "/abs.txt", body: Buffer.from("x") }])).rejects.toThrow(/Unsafe/);
  });

  it("refuses what the pinned archives never use", async () => {
    await expect(extract([{ name: "a", body: Buffer.from("x"), flags: 1 }])).rejects.toThrow(/Encrypted/);
    await expect(extract([{ name: "a", body: Buffer.from("x"), zip64: true }])).rejects.toThrow(/ZIP64/);
    const root = await tempRoot();
    const file = path.join(root, "not.zip");
    await fs.promises.writeFile(file, "not a zip at all, just some text that is long enough");
    await expect(extractZipFile(file, path.join(root, "out"))).rejects.toThrow(/Not a zip/);
  });
});

