import { execFile } from "node:child_process";
import { agyCredentialEnv, AGY_SIGN_IN_METHOD } from "./agy-auth";
import type { SubscriptionWindow } from "./subscription-usage";

const QUOTA_GROUPS: Readonly<Record<string, string>> = {
  "Gemini Models": "Gemini",
  "Claude and GPT models": "Claude & GPT",
};

/** Parse complete rows from agy's print-mode /usage command. */
export function agySubscriptionWindows(text: string, now = Date.now()): SubscriptionWindow[] {
  const result = new Map<string, SubscriptionWindow>();
  const observedAt = new Date(now).toISOString();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^\t]+)\t(Weekly|Five Hour) Limit Remaining\t(\d+(?:\.\d+)?)%\t(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/.exec(line);
    if (!match || !Object.hasOwn(QUOTA_GROUPS, match[1]) || +match[3] > 100) continue;
    const [, group, window, remaining, reset] = match;
    const end = new Date(reset);
    if (!Number.isFinite(+end) || end.toISOString() !== reset.replace("Z", ".000Z")) continue;
    const family = QUOTA_GROUPS[group];
    const weekly = window === "Weekly";
    const periodType = `${family === "Gemini" ? "gemini" : "claude-gpt"}_${weekly ? "weekly" : "5h"}`;
    result.set(periodType, { periodType, label: `${family} · ${weekly ? "Weekly" : "5-hour"}`,
      usedPercent: 100 - +remaining, periodEnd: end.toISOString(), observedAt });
  }
  return [...result.values()];
}

export function agyWindowsForModel(windows: readonly SubscriptionWindow[], modelId: string | undefined): SubscriptionWindow[] {
  const group = !modelId ? undefined : /^gemini-/.test(modelId) ? "gemini" : /^(?:claude|gpt)-/.test(modelId) ? "claude-gpt" : undefined;
  return group ? windows.filter((window) => window.periodType.startsWith(`${group}_`)) : [...windows];
}

/** Print mode reads the CLI's default profile. It does not create a conversation. */
export class AgyUsageMeter {
  private reading?: Promise<SubscriptionWindow[]>;

  constructor(
    private readonly binary: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly signal?: AbortSignal,
    private readonly timeout = 10_000,
  ) {}

  read(methodId: string = AGY_SIGN_IN_METHOD): Promise<SubscriptionWindow[]> {
    if (methodId !== AGY_SIGN_IN_METHOD || this.signal?.aborted) return Promise.resolve([]);
    return this.reading ??= new Promise<SubscriptionWindow[]>((resolve) => {
      const env = agyCredentialEnv(this.env);
      for (const name of Object.keys(env)) if (/^GOOGLE_API_KEY$/i.test(name)) delete env[name];
      execFile(this.binary, ["-p", "/usage"], {
        env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
        signal: this.signal, timeout: this.timeout, maxBuffer: 65_536, windowsHide: true,
      }, (error, stdout) => resolve(error ? [] : agySubscriptionWindows(stdout)));
    }).finally(() => { this.reading = undefined; });
  }
}
