import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const { mergeLinuxFeeds, verifyLinuxFeed, linuxNames } = require("../scripts/build-linux.cjs");
const yaml = require("js-yaml");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linux-packages-"));
  scratch.push(dir);
  const names = linuxNames("4.15.5");
  const feeds = Object.values(names).map((name) => {
    const content = Buffer.from(`artifact: ${name}`);
    fs.writeFileSync(path.join(dir, name as string), content);
    const sha512 = createHash("sha512").update(content).digest("base64");
    return { version: "4.15.5", files: [{ url: name, sha512, size: content.length }],
      path: name, sha512, releaseDate: "2026-10-29T00:00:00.000Z" };
  });
  const feed = mergeLinuxFeeds(feeds[0], feeds[1], "4.15.5");
  const save = () => fs.writeFileSync(path.join(dir, "latest-linux.yml"), yaml.dump(feed));
  save();
  return { dir, names, feeds, feed, save };
}

describe("Linux channel artifacts", () => {
  it("preserves both builder entries and AppImage legacy fields, with real checksums", async () => {
    const { dir, feed, feeds } = fixture();
    expect(feed).toEqual({ ...feeds[0], files: [...feeds[0].files, ...feeds[1].files] });
    await expect(verifyLinuxFeed(dir, "4.15.5")).resolves.toBeUndefined();
  });
  it("refuses swapped formats or mixed versions when merging", () => {
    const { feeds } = fixture();
    expect(() => mergeLinuxFeeds(feeds[1], feeds[0], "4.15.5")).toThrow();
    expect(() => mergeLinuxFeeds(feeds[0], { ...feeds[1], version: "4.15.4" }, "4.15.5")).toThrow();
  });
  it.each(["missing feed", "missing artifact", "corrupt artifact", "extra AppImage", "deb path", "wrong legacy hash"])(
    "fails publication on %s", async (fault) => {
      const { dir, names, feed, save } = fixture();
      if (fault === "missing feed") fs.unlinkSync(path.join(dir, "latest-linux.yml"));
      if (fault === "missing artifact") fs.unlinkSync(path.join(dir, names.deb));
      if (fault === "corrupt artifact") {
        const file = path.join(dir, names.deb);
        fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size)); // same size, wrong hash
      }
      if (fault === "extra AppImage") fs.writeFileSync(path.join(dir, "extra.AppImage"), "bad");
      if (fault === "deb path") { feed.path = names.deb; save(); }
      if (fault === "wrong legacy hash") { feed.sha512 = "bad"; save(); }
      await expect(verifyLinuxFeed(dir, "4.15.5")).rejects.toThrow();
    },
  );
});
