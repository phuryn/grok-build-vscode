import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { decideDefaultModeCohort, DEFAULT_MODE_COHORT_KEY } from "../src/default-mode-cohort";
import { DISK_KEYS } from "../src/persisted-state";

const dir = "/grok/client-state";
const marker = `${dir}/${DISK_KEYS[DEFAULT_MODE_COHORT_KEY]}`;
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function setup() {
  const files = new Map<string, string>();
  const values: Record<string, any> = {};
  const memento = {
    keys: () => Object.keys(values),
    get: (key: string, fallback?: any) => values[key] ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
  };
  const fs = {
    readFileSync: vi.fn((p: string) => files.get(p) ?? fail("ENOENT")),
    readdirSync: vi.fn((p: string) => [...files.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1))),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, value: string, opts: { flag?: string }) => {
      if (opts.flag === "wx" && files.has(p)) fail("EEXIST");
      files.set(p, value);
    }),
  };
  const inspect = vi.fn((): any => ({ key: "grok.defaultMode", defaultValue: "" }));
  const decide = () => decideDefaultModeCohort(memento, dir, fs, inspect);
  return { files, values, memento, fs, inspect, decide };
}

describe("machine-wide default-mode cohort", () => {
  it("persists a fresh decision before later first-run signals, shared across clients", () => {
    const s = setup();
    expect(s.decide()).toBe("new");
    expect(JSON.parse(s.files.get(marker)!)).toBe("new");
    s.files.set(`${dir}/install-id.json`, '"id"');
    s.values["grok.projectsInit"] = true;
    s.inspect.mockReturnValue({ globalValue: "agent" });
    expect(s.decide()).toBe("new");
    const other = setup();
    other.files.set(marker, s.files.get(marker)!);
    expect(other.decide()).toBe("new");
    expect(s.fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it.each(Object.entries(DISK_KEYS).filter(([key]) => key !== DEFAULT_MODE_COHORT_KEY))(
    "detects either disk or globalState trace for %s", (key, file) => {
      const disk = setup();
      disk.files.set(`${dir}/${file}`, "even an unreadable old file is a trace");
      expect(disk.decide()).toBe("existing");
      const host = setup();
      host.values[key] = {};
      expect(host.decide()).toBe("existing");
    });

  it.each(["grok.projectsInit", "grok.defaultMuseMode", "grok.moveViewHintUsed"])("detects host trace %s, including false/empty", key => {
    const s = setup();
    s.values[key] = key === "grok.defaultMuseMode" ? "" : false;
    expect(s.decide()).toBe("existing");
  });

  it.each(["globalValue", "workspaceValue", "workspaceFolderValue"])("detects an explicitly configured empty %s", scope => {
    const s = setup();
    s.inspect.mockReturnValue({ [scope]: "", defaultValue: "" });
    expect(s.decide()).toBe("existing");
  });

  it("counts any client-state trace, but ignores Grok CLI history", () => {
    const s = setup();
    s.files.set("/grok/sessions/cli-history.json", "{}");
    expect(s.decide()).toBe("new");
    const prior = setup();
    prior.files.set(`${dir}/routine-runs/run.json`, "{}");
    expect(prior.decide()).toBe("existing");
    prior.files.delete(`${dir}/routine-runs/run.json`);
    expect(prior.decide()).toBe("existing");
  });

  it("adopts a competing client's exclusive-create winner", () => {
    const s = setup();
    s.fs.writeFileSync.mockImplementationOnce(() => {
      s.files.set(marker, '"existing"');
      fail("EEXIST");
    });
    expect(s.decide()).toBe("existing");
  });

  it.each(["read", "list", "write", "inspect", "corrupt"])("falls back permanently when %s fails", failure => {
    const s = setup();
    if (failure === "read") s.fs.readFileSync.mockImplementationOnce(() => fail("EACCES"));
    if (failure === "list") s.fs.readdirSync.mockImplementationOnce(() => fail("EACCES"));
    if (failure === "write") s.fs.writeFileSync.mockImplementationOnce(() => fail("EACCES"));
    if (failure === "inspect") s.inspect.mockImplementationOnce(() => fail("unavailable"));
    if (failure === "corrupt") s.files.set(marker, "broken");
    expect(s.decide()).toBe("existing");
    expect(s.decide()).toBe("existing");
  });

  it("decides before state migration, provider migration or first-run writes", () => {
    const source = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const constructor = source.slice(source.indexOf("  constructor(\n    private context: HostContext,"));
    expect(constructor.indexOf("decideDefaultModeCohort(")).toBeLessThan(constructor.indexOf("new PersistedState("));
    expect(constructor.indexOf("decideDefaultModeCohort(")).toBeLessThan(constructor.indexOf("this.migrateProviderConnections()"));
  });
});
