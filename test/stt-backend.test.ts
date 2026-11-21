import { describe, expect, it } from "vitest";
import { pickSttBackend, resolveOpenAiVoiceKey, resolveGoogleVoiceKey, parseFinalVoiceCommand, type SttPreference } from "../src/voice";
import { INTERNAL_PROVIDERS } from "../src/acp-backend";

describe("pickSttBackend", () => {
  // Rows: no credential, xAI only, OpenAI only, both. Explicit choices are
  // deliberately literal expectations, not a copy of the selection algorithm.
  const expected = {
    grok: { auto: [undefined, "xai", "openai", "xai"], xai: [undefined, "xai", undefined, "xai"], openai: [undefined, undefined, "openai", "openai"] },
    codex: { auto: [undefined, "xai", "openai", "openai"], xai: [undefined, "xai", undefined, "xai"], openai: [undefined, undefined, "openai", "openai"] },
    claude: { auto: [undefined, "xai", "openai", "xai"], xai: [undefined, "xai", undefined, "xai"], openai: [undefined, undefined, "openai", "openai"] },
  };
  for (const provider of ["grok", "codex", "claude"] as const) {
    for (const preference of [undefined, "auto", "xai", "openai"] as Array<SttPreference | undefined>) {
      for (const [index, [hasXai, hasOpenAi]] of [[false, false], [true, false], [false, true], [true, true]].entries()) {
        it(`${provider}, ${preference ?? "default"}, xAI=${hasXai}, OpenAI=${hasOpenAi}`, () => {
          expect(pickSttBackend({ provider, preference, hasXai, hasOpenAi })).toBe(expected[provider][preference ?? "auto"][index]);
        });
      }
    }
  }
  it("preserves dictation for an existing xAI-only Codex user on upgrade", () => {
    expect(pickSttBackend({ provider: "codex", hasXai: true, hasOpenAi: false })).toBe("xai");
  });

  it("resolves Auto and all three strict choices for every provider and credential combination", () => {
    // Bits in mask order: xAI, OpenAI, Google.
    const auto = {
      grok: [undefined, "xai", "openai", "xai", "google", "xai", "openai", "xai"],
      codex: [undefined, "xai", "openai", "openai", "google", "xai", "openai", "openai"],
      claude: [undefined, "xai", "openai", "xai", "google", "xai", "openai", "xai"],
      muse: [undefined, "xai", "openai", "xai", "google", "xai", "openai", "xai"],
      agy: [undefined, "xai", "openai", "xai", "google", "google", "google", "google"],
      deepseek: [undefined, "xai", "openai", "xai", "google", "xai", "openai", "xai"],
    };
    for (const provider of INTERNAL_PROVIDERS) {
      for (let mask = 0; mask < 8; mask++) {
        const opts = { provider, hasXai: !!(mask & 1), hasOpenAi: !!(mask & 2), hasGoogle: !!(mask & 4) };
        expect(pickSttBackend(opts)).toBe(auto[provider][mask]);
        expect(pickSttBackend({ ...opts, preference: "xai" })).toBe(opts.hasXai ? "xai" : undefined);
        expect(pickSttBackend({ ...opts, preference: "openai" })).toBe(opts.hasOpenAi ? "openai" : undefined);
        expect(pickSttBackend({ ...opts, preference: "google" })).toBe(opts.hasGoogle ? "google" : undefined);
      }
    }
  });
});

describe("OpenAI key resolution", () => {
  it("prefers setting, trims values, then uses only OPENAI_API_KEY", () => {
    expect(resolveOpenAiVoiceKey({ setting: " key ", env: { OPENAI_API_KEY: "env" } })).toBe("key");
    expect(resolveOpenAiVoiceKey({ setting: " ", env: { OPENAI_API_KEY: " env " } })).toBe("env");
    expect(resolveOpenAiVoiceKey({ env: { XAI_API_KEY: "xai", GROK_VOICE_API_KEY: "grok", access_token: "oauth" } })).toBeUndefined();
    expect(resolveOpenAiVoiceKey({})).toBeUndefined();
  });
});

it("resolves the Google voice setting, stored API key, GEMINI_API_KEY and GOOGLE_API_KEY in order", () => {
  const env = { GEMINI_API_KEY: " gemini-env ", GOOGLE_API_KEY: " google-env " };
  expect(resolveGoogleVoiceKey({ setting: " voice ", savedKey: " stored ", env })).toBe("voice");
  expect(resolveGoogleVoiceKey({ setting: " ", savedKey: " stored ", env })).toBe("stored");
  expect(resolveGoogleVoiceKey({ savedKey: " ", env })).toBe("gemini-env");
  expect(resolveGoogleVoiceKey({ env: { ...env, GEMINI_API_KEY: " " } })).toBe("google-env");
  expect(resolveGoogleVoiceKey({ env: { OPENAI_API_KEY: "elsewhere" } })).toBeUndefined();
});

describe("finalized voice commands", () => {
  it("retains a partial send phrase as draft and sends only the finalized match", () => {
    expect(parseFinalVoiceCommand("fix it grok send", "fix it", "grok send")).toEqual({ text: "fix it grok send", send: false });
    expect(parseFinalVoiceCommand("fix it grok send", "fix it grok send", "grok send")).toEqual({ text: "fix it", send: true });
    expect(parseFinalVoiceCommand("fix it Grok said", "fix it Grok said", "grok send").send).toBe(false);
  });
});
