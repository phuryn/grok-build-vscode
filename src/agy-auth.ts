import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { agyProfileDir, type AgyProfile } from "./agy-backend";
import type { DeviceLoginCallbacks, DeviceLoginHandle } from "./device-login-run";

export const AGY_SIGN_IN_METHOD = "oauth-personal";
export const AGY_KEY_METHOD = "gemini-api-key";
export const AGY_SIGN_IN_TIMEOUT_MS = 330_000;
/** Gemini keys are about 40 characters; anything near this is not one. */
export const MAX_AGY_API_KEY_CHARS = 512;

/** How a person chose to sign Antigravity in on this machine. */
export type AgySignInMethod = "google" | "api-key";

export function isAgySignInMethod(value: unknown): value is AgySignInMethod {
  return value === "google" || value === "api-key";
}

/** Only the saved key enters a chat process. Drop any inherited copy. */
export function agyCredentialEnv(env: NodeJS.ProcessEnv, key?: string): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GEMINI_API_KEY$/i.test(name)));
  if (key) clean.GEMINI_API_KEY = key;
  return clean;
}

/** A pasted key, trimmed, or the sentence that says why it is not one. */
export function normalizeAgyApiKey(raw: unknown): { key: string } | { error: string } {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { error: "Paste a Gemini API key." };
  if (key.length > MAX_AGY_API_KEY_CHARS || /\s/.test(key)) return { error: "That does not look like a Gemini API key." };
  return { key };
}

export interface AgyCredentialProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (file: string) => boolean;
  /** The OS credential store's entry for the CLI's Google sign-in. */
  storeEntry?: () => Promise<boolean>;
}

/** Where the CLI keeps its Google sign-in (measured on 1.5.8): the OS credential
 *  store under service `gemini`, account `antigravity` -- Windows Credential
 *  Manager shows the target `gemini:antigravity` -- or the profile's
 *  `antigravity-oauth-token` file when the store is unavailable, as on a Mac
 *  signed in over SSH. The 4.17.3 server wrote `acp_token.json` instead.
 *  Both store reads list attributes only, never the secret, and never prompt. */
const AGY_TOKEN_FILES = ["antigravity-oauth-token", "acp_token.json"];
/** `cmdkey /list:<target>` names the target in its header whether or not it
 *  exists, then `* NONE *` or one indented `Target:` line (label localized). */
export function cmdkeyListsAgyEntry(stdout: string): boolean {
  return /^\s+[^\r\n:]+:\s*(?:LegacyGeneric:target=)?gemini:antigravity\s*$/im.test(stdout);
}

export function agyStoreEntryPresent(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return new Promise((resolve) => {
    if (platform === "darwin") {
      execFile("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity"],
        { timeout: 5_000 }, (error) => resolve(!error));
    } else if (platform === "win32") {
      execFile("cmdkey", ["/list:gemini:antigravity"], { timeout: 5_000, windowsHide: true },
        (error, stdout) => resolve(!error && cmdkeyListsAgyEntry(String(stdout))));
    } else resolve(false);
  });
}

/** A saved credential is a hint. Successful CLI authentication is proof. */
export async function agyGoogleSignInPresent(profile: AgyProfile, probe: AgyCredentialProbe = {}): Promise<boolean> {
  const exists = probe.exists ?? fs.existsSync;
  const dir = agyProfileDir(profile, probe.env, probe.home);
  if (AGY_TOKEN_FILES.some((name) => exists(path.join(dir, name)))) return true;
  if (profile !== "cli") return false;
  return probe.storeEntry ? probe.storeEntry() : agyStoreEntryPresent(probe.platform);
}

const CLI_SIGN_IN_PROMPT = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/;

export function agySignInUrl(stderr: string): string | undefined {
  return CLI_SIGN_IN_PROMPT.exec(stderr)?.[0];
}

/** A conversation startup must not wait for an interactive OAuth redirect. */
export async function startAgyGoogleChat(client: AgySignInClient): Promise<void> {
  await client.start();
  let stderr = "";
  let listener: (text: string) => void = () => {};
  const needsSignIn = new Promise<never>((_resolve, reject) => {
    listener = (text) => {
      stderr = (stderr + text).slice(-16_384);
      if (agySignInUrl(stderr)) reject(new Error("Antigravity authentication required."));
    };
    client.on("stderr", listener);
  });
  try {
    await Promise.race([needsSignIn, client.authenticate(AGY_SIGN_IN_METHOD, 10_000)]);
  } catch (error) {
    if (/timed out: authenticate/i.test(errorText(error))) throw new Error("Antigravity authentication required.");
    throw error;
  } finally {
    client.off?.("stderr", listener);
  }
}

/** What the sign-in needs from an ACP client; `AcpClient` satisfies it. */
export interface AgySignInClient {
  start(): Promise<void>;
  authenticate(methodId: string, timeoutMs: number): Promise<unknown>;
  dispose(): Promise<void>;
  on(event: "stderr", listener: (text: string) => void): unknown;
  off?(event: "stderr", listener: (text: string) => void): unknown;
}

function errorText(error: unknown): string {
  const value = error as any;
  return String(value?.data?.message ?? value?.message ?? value ?? "");
}

export const AGY_PASTE_ADDRESS_ERROR = "That is not the address from this sign-in. Copy the full address from the page that did not load.";
export const AGY_REDIRECT_TIMEOUT_MS = 300_000;

/** Only the printed OAuth link chooses where the host may send the callback. */
export function agySignInCallback(pasted: string, signInUrl: string): { port: number; path: string } | undefined {
  try {
    const auth = new URL(signInUrl);
    const redirect = new URL(auth.searchParams.get("redirect_uri") ?? "");
    const callback = new URL(pasted);
    const loopback = (url: URL) => url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
      && !url.username && !url.password;
    const state = auth.searchParams.get("state");
    if (!loopback(redirect) || !redirect.port || Number(redirect.port) === 0 || !loopback(callback)
      || callback.port !== redirect.port || !callback.searchParams.get("code")?.trim()
      || callback.searchParams.getAll("code").length !== 1 || !state
      || callback.searchParams.get("state") !== state || callback.searchParams.getAll("state").length !== 1) return undefined;
    return { port: Number(redirect.port), path: callback.pathname + callback.search };
  } catch { return undefined; }
}

function requestAgyCallback(target: { port: number; path: string }, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // No redirects, proxy or DNS lookup: neither the pasted host nor a response
    // Location can turn this into a request away from the server's loopback port.
    const request = http.get({ hostname: "127.0.0.1", port: target.port, path: target.path, signal, agent: false }, response => {
      response.resume();
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) resolve();
      else reject(new Error("Antigravity did not accept the callback."));
    });
    request.setTimeout(5_000, () => request.destroy(new Error("Antigravity callback timed out.")));
    request.on("error", reject);
  });
}

/**
 * Google sign-in through the CLI's own `authenticate`. A cloud host accepts
 * the phone's failed loopback address; the CLI keeps its PKCE verifier and
 * exchanges the code itself. Desk browser sign-in retains its existing flow.
 */
export function runAgySignIn(client: AgySignInClient, callbacks: DeviceLoginCallbacks, opts: {
  pasteRedirect?: boolean;
  requestCallback?: typeof requestAgyCallback;
} = {}): DeviceLoginHandle {
  let settled = false;
  let prompted = false;
  let submitted = false;
  let stderr = "";
  let signInUrl: string | undefined;
  let redirectTimer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const settle = (result: Parameters<DeviceLoginCallbacks["onDone"]>[0]) => {
    if (settled) return;
    settled = true;
    if (redirectTimer) clearTimeout(redirectTimer);
    controller.abort();
    signInUrl = undefined;
    stderr = "";
    callbacks.onDone(result);
  };
  client.on("stderr", (text) => {
    if (prompted || settled) return;
    stderr = (stderr + text).slice(-16_384);
    const url = agySignInUrl(stderr);
    if (!url) return;
    prompted = true;
    signInUrl = url;
    if (opts.pasteRedirect) {
      redirectTimer = setTimeout(() => {
        settle({ ok: false, failure: "expired", output: "" });
        void client.dispose().catch(() => undefined);
      }, AGY_REDIRECT_TIMEOUT_MS);
      redirectTimer.unref?.();
    }
    callbacks.onPrompt({ url, ...(opts.pasteRedirect ? { needsCode: true } : {}) });
  });
  void (async () => {
    try {
      await client.start();
      if (settled) return;
      await client.authenticate(AGY_SIGN_IN_METHOD, AGY_SIGN_IN_TIMEOUT_MS);
      settle({ ok: true, output: "" });
    } catch (error) {
      const expired = opts.pasteRedirect && /timed?\s*out|timeout|expired/i.test(errorText(error));
      settle({ ok: false, failure: expired ? "expired" : "failed", output: opts.pasteRedirect ? "" : errorText(error) });
    } finally {
      await client.dispose().catch(() => undefined);
    }
  })();
  return {
    cancel: () => {
      if (settled) return;
      settle({ ok: false, cancelled: true, output: "" });
      void client.dispose().catch(() => undefined);
    },
    submitCode: (pasted) => {
      if (settled || submitted || !opts.pasteRedirect) return false;
      const target = signInUrl ? agySignInCallback(pasted, signInUrl) : undefined;
      if (!target) {
        callbacks.onInputRejected?.(AGY_PASTE_ADDRESS_ERROR);
        return false;
      }
      submitted = true;
      void (opts.requestCallback ?? requestAgyCallback)(target, controller.signal).catch(() => {
        if (settled) return;
        submitted = false;
        callbacks.onInputRejected?.("Could not send the address to Antigravity. Paste it again while this sign-in is still waiting.");
      });
      return true;
    },
  };
}
