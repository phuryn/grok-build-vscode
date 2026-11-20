import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";
import { AgyBackend, listAgyCatalog } from "../src/agy-backend";
import { agyMeterDirectory, agySubscriptionWindows, agyUsageCredentialContext, AgyUsageMeter } from "../src/agy-usage";

const usageText: string = require("./fixtures/agy-usage-text.json");
const FAKE = path.join(__dirname, "fixtures", "fake-agy-acp.cjs");

describe("Antigravity quota windows", () => {
  it("uses the reported group, remaining percentage, and UTC reset", () => {
    const observedAt = "2026-11-20T19:00:00.000Z";
    expect(agySubscriptionWindows(usageText, Date.parse(observedAt))).toEqual([
      { label: "Gemini · Weekly", periodType: "gemini_weekly", usedPercent: 53, periodEnd: "2026-11-25T23:12:00.000Z", observedAt },
      { label: "Gemini · 5-hour", periodType: "gemini_5h", usedPercent: 0, periodEnd: "2026-11-20T21:18:00.000Z", observedAt },
      { label: "Claude & GPT · Weekly", periodType: "claude-gpt_weekly", usedPercent: 0, periodEnd: "2026-11-27T19:30:00.000Z", observedAt },
      { label: "Claude & GPT · 5-hour", periodType: "claude-gpt_5h", usedPercent: 0, periodEnd: "2026-11-21T00:30:00.000Z", observedAt },
    ]);
  });

  it("skips unfamiliar groups, percentages outside the range, and invalid or missing reset times", () => {
    const unreadable = usageText.replace("Gemini Models", "Other Models")
      .replace("resets Nov 27, 2026, 19:30 UTC", "resets Nov 31, 2026, 19:30 UTC")
      .replace("100% remaining (resets Nov 21", "101% remaining (resets Nov 21");
    expect(agySubscriptionWindows(unreadable)).toEqual([]);
    expect(agySubscriptionWindows(usageText.replace("(resets Nov 25, 2026, 23:12 UTC)", "")).map(w => w.periodType))
      .toEqual(["gemini_5h", "claude-gpt_weekly", "claude-gpt_5h"]);
    expect(agySubscriptionWindows(usageText.replace("Quota Limits", "Something else"))).toEqual([]);
  });
});

describe("Antigravity meter over ACP (real transport, fake managed server)", () => {
  let home: string;
  let profile: string;
  let env: NodeJS.ProcessEnv;
  let sink: string;
  const meters: AgyUsageMeter[] = [];
  const clients: AcpClient[] = [];
  const requests = () => fs.readFileSync(sink, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const databases = () => fs.readdirSync(path.join(profile, "conversations")).filter(name => name.endsWith(".db"));
  const token = { client_id: "fake", refresh_token: "fake-refresh", project_id: "fake-project" };
  function meter(extra: NodeJS.ProcessEnv = {}) {
    const made = new AgyUsageMeter(FAKE, { ...env, ...extra }, undefined, 125);
    meters.push(made);
    return made;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpdir(), "agy-usage-"));
    profile = path.join(home, "antigravity-acp");
    sink = path.join(home, "requests.jsonl");
    env = { ...process.env, GEMINI_HOME: home, FAKE_AGY_152: "1", FAKE_AGY_SINK: sink };
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, "acp_token.json"), JSON.stringify(token));
    fs.writeFileSync(sink, "");
  });

  afterEach(async () => {
    await Promise.all([...meters.splice(0), ...clients.splice(0)].map(made => made.dispose()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("uses one hidden conversation across concurrent reads, a warm refresh, and a process restart", async () => {
    const usage = meter();
    const human = new AcpClient({ cliPath: FAKE, cwd: home, env, log: () => {}, startupAuth: { methodId: "oauth-personal" },
      backend: new AgyBackend({ usageMeter: usage }) });
    clients.push(human);
    await human.start();
    const { sessionId } = await human.newSession();
    await human.setMode("acceptEdits");
    const chunks: string[] = [];
    human.on("messageChunk", text => chunks.push(text));

    const concurrent = await Promise.all([human.getSubscriptionUsage(), human.getSubscriptionUsage()]);
    expect(concurrent[0]).toHaveLength(4);
    expect(concurrent[1]).toEqual(concurrent[0]);
    expect(await usage.read()).toHaveLength(4);
    await usage.dispose();
    expect(await meter().read()).toHaveLength(4);

    const meterId = JSON.parse(fs.readFileSync(path.join(agyMeterDirectory(profile), "session.json"), "utf8")).sessionId;
    expect(databases()).toHaveLength(2);
    expect(listAgyCatalog(process.platform, { env }).map(row => row.sessionId)).toEqual([sessionId]);
    expect(human.sessionId).toBe(sessionId);
    expect(human.currentModeId).toBe("acceptEdits");
    expect(chunks).toEqual([]);
    const received = requests();
    expect(received.filter(r => r.method === "initialize")).toHaveLength(3);
    expect(received.filter(r => r.method === "session/new")).toHaveLength(2);
    expect(received.filter(r => r.method === "session/resume").map(r => r.params.sessionId)).toEqual([meterId, meterId]);
    expect(received.filter(r => r.method === "session/prompt").map(r => r.params.sessionId)).toEqual([meterId, meterId, meterId]);
    expect(received.filter(r => r.method === "refusedRequest")).toHaveLength(3);
  });

  it("recovers a lost create response by cwd and replaces a confirmed deletion once", async () => {
    const usage = meter({ FAKE_AGY_LOSE_METER_CREATE: "1" });
    expect(await usage.read()).toEqual([]);
    const [initial] = databases();
    expect(initial).toBeDefined();
    expect(listAgyCatalog(process.platform, { env })).toEqual([]);
    const reopened = meter();
    expect(await reopened.read()).toHaveLength(4);
    expect(databases()).toEqual([initial]);
    fs.rmSync(path.join(profile, "conversations", initial));
    expect(await reopened.read()).toHaveLength(4);
    expect(databases()).toHaveLength(1);
    expect(databases()).not.toContain(initial);
    expect(requests().filter(r => r.method === "session/new")).toHaveLength(2);
  });

  it("stays empty for an API key or absent credentials and keeps the cache identity across access-token rotation", async () => {
    const usage = meter();
    const original = agyUsageCredentialContext(profile, "oauth-personal");
    expect(original).toMatch(/^agy:[a-f0-9]{64}$/);
    const tokenFile = path.join(profile, "acp_token.json");
    fs.writeFileSync(tokenFile, JSON.stringify({ ...token, access_token: "rotated" }));
    expect(usage.credentialContext()).toBe(original);
    expect(await usage.read("gateway")).toEqual([]);
    fs.rmSync(tokenFile);
    expect(await usage.read()).toEqual([]);
    expect(requests()).toEqual([]);
  });
});
