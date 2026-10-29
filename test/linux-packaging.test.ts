import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

const { mergeLinuxFeeds, verifyLinuxFeed, linuxNames } = require("../scripts/build-linux.cjs");
const yaml = require("js-yaml");
const root = path.resolve(__dirname, "..");
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

// Exercise the real build orchestration without spawning Linux tools. Only
// child processes are replaced; staged files/feed merging use a disposable root.
async function buildCommands(extraArgs: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linux-build-args-"));
  scratch.push(dir);
  const calls: { command: string; args: string[] }[] = [];
  const version = require("../package.json").version;
  const names = linuxNames(version);
  const spawnSync = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === process.execPath) {
      const target = args[args.indexOf("--linux") + 1];
      const output = args.find(arg => arg.startsWith("-c.directories.output="))!.split("=")[1];
      const name = target === "deb" ? names.deb : names.appimage;
      const content = Buffer.from(`artifact: ${name}`);
      const sha512 = createHash("sha512").update(content).digest("base64");
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, name), content);
      fs.writeFileSync(path.join(output, "latest-linux.yml"), yaml.dump({
        version, files: [{ url: name, sha512, size: content.length }], path: name, sha512,
      }));
    } else if (command !== "bash") {
      throw new Error(`unexpected build command: ${command}`);
    }
    return { status: 0 };
  };
  const localRequire = Object.assign(
    (id: string) => id === "node:child_process" ? { spawnSync } : require(id),
    { resolve: require.resolve },
  );
  await runInNewContext(fs.readFileSync(path.join(root, "scripts/build-linux.cjs"), "utf8") +
    "\nbuildLinux(testExtraArgs);", {
    require: localRequire, module: { exports: {} }, __dirname: path.join(dir, "scripts"),
    process: { platform: "linux", execPath: process.execPath }, testExtraArgs: extraArgs,
  });
  return { dir, calls };
}

describe("Debian install path and branding", () => {
  it("overrides only the isolated deb build and preserves builder-generated identity", async () => {
    const { dir, calls } = await buildCommands(["-c.extraMetadata.grokExtensionName=grok-vscode-phuryn"]);
    expect(calls).toHaveLength(3);
    const [appimage, deb, verify] = calls;
    expect(appimage.args.slice(1, 6)).toEqual(["--linux", "AppImage", "--x64", "--publish", "never"]);
    expect(deb.args.slice(1, 6)).toEqual(["--linux", "deb", "--x64", "--publish", "never"]);
    expect(appimage.args.some(arg => arg.startsWith("-c.productName="))).toBe(false);
    const productNameArg = deb.args.find(arg => arg.startsWith("-c.productName="));
    expect(productNameArg).toBe("-c.productName=grok-build-desktop");
    const outputArg = (call: typeof deb) => call.args.find(arg => arg.startsWith("-c.directories.output="));
    expect(outputArg(appimage)).not.toBe(outputArg(deb));
    for (const call of [appimage, deb]) {
      expect(call.args).toContain("-c.extraMetadata.grokCloudBuild=true");
      expect(call.args).toContain("-c.extraMetadata.grokExtensionName=grok-vscode-phuryn");
    }
    expect(verify.command).toBe("bash");
    expect(verify.args[1]).toBe("--static");

    // Use the installed builder implementation, including its hook expansion
    // and metadata transformer, so this checks generated output, not our YAML.
    const { LinuxPackager } = require("app-builder-lib");
    const { LinuxTargetHelper } = require("app-builder-lib/out/targets/LinuxTargetHelper");
    const FpmTarget = require("app-builder-lib/out/targets/FpmTarget").default;
    const { createTransformer } = require("app-builder-lib/out/fileTransformer");
    const base = yaml.load(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
    expect(base.productName).toBe("Grok Build Desktop");
    const config = { ...base, productName: productNameArg!.split("=")[1] };
    const metadata = { ...require("../package.json"), ...config.extraMetadata };
    const packager = new LinuxPackager({ config, metadata, projectDir: root,
      tempDirManager: { getTempFile: async ({ suffix }: { suffix: string }) => path.join(dir, suffix) },
    });
    const helper = new LinuxTargetHelper(packager);
    const target = new FpmTarget("deb", packager, helper, dir);
    const desktop = await helper.computeDesktopEntry(target.options);
    for (const line of ["Name=Grok Build Desktop", "StartupWMClass=Grok Build Desktop (Community)",
      "Exec=/opt/grok-build-desktop/grok-build-desktop %U", "Icon=grok-build-desktop"]) {
      expect(desktop.split("\n")).toContain(line);
    }
    expect(packager.appInfo.sanitizedProductName).toBe("grok-build-desktop");
    expect(packager.appInfo.productFilename).toBe("grok-build-desktop");
    expect(packager.appInfo.updaterCacheDirName).toBe("grok-build-desktop-updater");
    expect((await target.computeFpmMetaInfoOptions()).name).toBe("grok-build-desktop");
    expect(target.options.synopsis).toBe("Desktop client for Grok Build");
    expect(helper.getDescription(target.options)).toBe(
      "Desktop client for the Grok Build agent. Talks to Grok, Codex, " +
      "Claude Code and Muse Code. Not affiliated with or endorsed by SpaceXAI.");
    const [postinst, postrm] = (await target.scriptFiles).map((file: string) => fs.readFileSync(file, "utf8"));
    expect(postinst).toContain("chmod 4755 '/opt/grok-build-desktop/chrome-sandbox'");
    for (const hook of [postinst, postrm]) {
      expect(hook).toContain("'/opt/grok-build-desktop/grok-build-desktop'");
      expect(hook).not.toContain("${sanitizedProductName}");
    }
    const packageFile = path.join(root, "package.json");
    const original = JSON.parse(await createTransformer(root, base, base.extraMetadata)(packageFile));
    const overridden = JSON.parse(await createTransformer(root, config, config.extraMetadata)(packageFile));
    expect(overridden).toEqual(original);
    expect(overridden).not.toHaveProperty("productName");
    expect(overridden.name).toBe("grok-build-desktop");
    expect(overridden.description).toBe("Grok Build Desktop (Community)");
  });

  it.each(["-c.productName=other", "-c.directories.output=other", "--publish=always"])(
    "rejects external build overrides: %s", async arg => {
      await expect(buildCommands([arg])).rejects.toThrow();
    },
  );
});

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
