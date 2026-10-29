import { describe, expect, it } from "vitest";
import { extensionIdFromPackageMeta, isCloudBuildFromPackageMeta, PACKAGED_EXTENSION_NAME_FIELD, readLinuxPackageType } from "../src/desktop/package-meta";
import { OFFICIAL_EXTENSION_ID } from "../src/telemetry";

describe("readLinuxPackageType", () => {
  it("recognizes the deb marker and a missing AppImage marker", () => {
    expect(readLinuxPackageType(() => "deb\n")).toBe("deb");
    expect(readLinuxPackageType(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })).toBe("appimage");
  });
  it("fails closed on unreadable or unexpected markers", () => {
    for (const code of ["EACCES", "EIO"]) {
      expect(readLinuxPackageType(() => { throw Object.assign(new Error(code), { code }); })).toBe("unknown");
    }
    for (const marker of ["", "rpm", "deb-untrusted"]) {
      expect(readLinuxPackageType(() => marker)).toBe("unknown");
    }
  });
});

describe("extensionIdFromPackageMeta", () => {
  it("restores the name half that extraMetadata.name overwrites", () => {
    expect(PACKAGED_EXTENSION_NAME_FIELD).toBe("grokExtensionName");
    // Exactly what a packaged asar carries: electron-builder has rewritten
    // `name`, so the derived id would otherwise be PawelHuryn.grok-build-desktop.
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
      grokExtensionName: "grok-vscode-phuryn",
    })).toBe(OFFICIAL_EXTENSION_ID);
  });

  // The property this field must never break. A fork publishes under its own
  // publisher; if the full id were baked into electron-builder.yml the fork
  // would inherit ours and report into the official Aptabase project without
  // anyone intending it. Only the NAME is carried, so `publisher` still decides.
  it("still opts a fork out when it changes publisher", () => {
    expect(extensionIdFromPackageMeta({
      publisher: "Acme",
      name: "grok-build-desktop",
      grokExtensionName: "grok-vscode-phuryn",
    })).toBe("Acme.grok-vscode-phuryn");
    expect(extensionIdFromPackageMeta({
      publisher: "Acme",
      name: "grok-build-desktop",
      grokExtensionName: "grok-vscode-phuryn",
    })).not.toBe(OFFICIAL_EXTENSION_ID);
  });

  it("falls back to the packaged name when the field is missing or blank", () => {
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
    })).toBe("PawelHuryn.grok-build-desktop");
    expect(extensionIdFromPackageMeta({
      publisher: "PawelHuryn",
      name: "grok-build-desktop",
      grokExtensionName: "   ",
    })).toBe("PawelHuryn.grok-build-desktop");
  });

  it("falls back to the official values only when the package says nothing", () => {
    expect(extensionIdFromPackageMeta({})).toBe(OFFICIAL_EXTENSION_ID);
    expect(extensionIdFromPackageMeta({
      publisher: 7 as unknown as string,
      name: null as unknown as string,
    })).toBe(OFFICIAL_EXTENSION_ID);
  });
});

describe("isCloudBuildFromPackageMeta", () => {
  it("is true only for the flag electron-builder actually writes", () => {
    // extraMetadata passes through whatever it is given, and a boolean or the
    // string "true" both arrive depending on how the flag was written.
    expect(isCloudBuildFromPackageMeta({ grokCloudBuild: true })).toBe(true);
    expect(isCloudBuildFromPackageMeta({ grokCloudBuild: "true" })).toBe(true);
  });

  it("is false for anything else, including a stray falsy string", () => {
    // A build that trusts its environment must never be reached by accident.
    for (const v of [undefined, false, "false", "1", 1, null, {}, ""]) {
      expect(isCloudBuildFromPackageMeta({ grokCloudBuild: v })).toBe(false);
    }
  });

  it("is false for an ordinary package with no flag at all", () => {
    expect(isCloudBuildFromPackageMeta({})).toBe(false);
  });
});
