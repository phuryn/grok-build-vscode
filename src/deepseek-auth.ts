export const DEEPSEEK_API_KEY_SECRET = "grok.deepseekApiKey";
export const MAX_DEEPSEEK_API_KEY_LENGTH = 512;
export function validDeepSeekKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DEEPSEEK_API_KEY_LENGTH && !/\s|[\x00-\x1f\x7f]/.test(value);
}
export function deepseekKey(env: NodeJS.ProcessEnv, saved?: string): { key?: string; source?: "environment" | "saved" } {
  if (validDeepSeekKey(env.DEEPSEEK_API_KEY)) return { key: env.DEEPSEEK_API_KEY, source: "environment" };
  return validDeepSeekKey(saved) ? { key: saved, source: "saved" } : {};
}
export function isDeepSeekCredentialError(error: unknown): boolean {
  const e = error as { message?: string; data?: unknown } | undefined;
  const message = `${e?.message ?? String(error)} ${typeof e?.data === "string" ? e.data : JSON.stringify(e?.data) ?? ""}`;
  return /\b401\b|MISSING_CREDENTIAL|invalid.api.key|authentication.fail|incorrect.api.key/i.test(message);
}
export const DEEPSEEK_KEY_REJECTED = "DeepSeek rejected its API key. Update DEEPSEEK_API_KEY on the desk host or the saved DeepSeek key in Settings. Environment takes precedence. Your message was not resent.";
export function deepseekPromptErrorText(error: unknown): string {
  if (isDeepSeekCredentialError(error)) return DEEPSEEK_KEY_REJECTED;
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate.limit/i.test(message)) return "DeepSeek is rate-limiting requests. Wait before trying again.";
  if (/timed? out|timeout/i.test(message)) return "DeepSeek did not answer in time. Try again when the harness is ready.";
  // Vendor error bodies may echo credentials. Only the ACP logger, which has
  // the launch key's redactor, receives those details; no raw body goes remote.
  return "DeepSeek could not complete this request. Check the DeepSeek logs on the host for details.";
}
