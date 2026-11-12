/**
 * Prefix every `appendLine` on VS Code's "AFK Pilot" output channel with an
 * ISO-8601 UTC time, the same clock the desktop log (`desktop/main.ts`) and
 * the agents' own session files use, so a pasted log lines up with them (#233:
 * a user could not tell when grok exited relative to their session files).
 *
 * Wraps the channel once where it is created, so every writer gets the stamp:
 * the host's `appendLine`, the placement and move logs, and anything added
 * later. `append` stays raw: it carries stderr chunks that are not whole lines.
 */
export function withLineTimestamps<T extends { appendLine(line: string): void }>(
  channel: T,
  now: () => Date = () => new Date(),
): T {
  return new Proxy(channel, {
    get(target, prop) {
      if (prop === "appendLine") {
        return (line: string) => target.appendLine(`[${now().toISOString()}] ${line}`);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
