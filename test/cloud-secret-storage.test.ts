import { describe, expect, it, vi } from "vitest";
import { useBuiltInKeyOnCloudMachine, type SafeStorageLike } from "../src/desktop/safe-secrets";

function storage(available: boolean): SafeStorageLike & { setUsePlainTextEncryption: ReturnType<typeof vi.fn> } {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(text),
    decryptString: (data) => data.toString(),
    setUsePlainTextEncryption: vi.fn(),
  };
}

describe("secret storage on a machine with no keychain", () => {
  it("uses Electron's built-in key on a Linux cloud machine, so a pasted key can be saved", () => {
    const s = storage(false);
    expect(useBuiltInKeyOnCloudMachine(s, { platform: "linux", cloud: true })).toBe(true);
    expect(s.setUsePlainTextEncryption).toHaveBeenCalledWith(true);
  });

  it("keeps the strict rule on a desk: no keychain, no stored secret (#209)", () => {
    const s = storage(false);
    expect(useBuiltInKeyOnCloudMachine(s, { platform: "linux", cloud: false })).toBe(false);
    expect(s.setUsePlainTextEncryption).not.toHaveBeenCalled();
  });

  it("leaves a working keychain alone, and does nothing off Linux", () => {
    const withKeychain = storage(true);
    expect(useBuiltInKeyOnCloudMachine(withKeychain, { platform: "linux", cloud: true })).toBe(false);
    expect(withKeychain.setUsePlainTextEncryption).not.toHaveBeenCalled();
    for (const platform of ["win32", "darwin"] as const) {
      const s = storage(false);
      expect(useBuiltInKeyOnCloudMachine(s, { platform, cloud: true })).toBe(false);
      expect(s.setUsePlainTextEncryption).not.toHaveBeenCalled();
    }
  });
});
