import { describe, expect, it } from "vitest";
import { withLineTimestamps } from "../src/output-timestamps";

class FakeChannel {
  readonly name = "AFK Pilot";
  readonly lines: string[] = [];
  raw = "";
  disposed = false;
  appendLine(line: string) { this.lines.push(line); }
  append(text: string) { this.raw += text; }
  dispose() { this.disposed = true; }
}

describe("withLineTimestamps (#233)", () => {
  it("prefixes every line with the ISO UTC time it was written", () => {
    const channel = new FakeChannel();
    let t = Date.parse("2026-11-11T08:47:44.123Z");
    const out = withLineTimestamps(channel, () => new Date(t));
    out.appendLine("Grok process exited with code 1");
    t += 1500;
    out.appendLine("spawning grok.exe agent stdio");
    expect(channel.lines).toEqual([
      "[2026-11-11T08:47:44.123Z] Grok process exited with code 1",
      "[2026-11-11T08:47:45.623Z] spawning grok.exe agent stdio",
    ]);
  });

  it("leaves raw stderr chunks alone and keeps the channel's other members working", () => {
    const channel = new FakeChannel();
    const out = withLineTimestamps(channel, () => new Date(0));
    out.append("partial chunk ");
    out.append("of stderr\n");
    expect(channel.raw).toBe("partial chunk of stderr\n");
    expect(out.name).toBe("AFK Pilot");
    out.dispose();
    expect(channel.disposed).toBe(true);
  });
});
