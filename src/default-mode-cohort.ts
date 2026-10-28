import { DISK_KEYS, type MementoLike, type StateFs } from "./persisted-state";
import { MUSE_MODE_PREF_KEY } from "./mode-prefs";
import type { ConfigInspect } from "./host";

export const DEFAULT_MODE_COHORT_KEY = "grok.defaultModeCohort";
export type DefaultModeCohort = "new" | "existing";
type CohortFs = Pick<StateFs, "readFileSync" | "writeFileSync" | "mkdirSync"> & {
  readdirSync(path: string): string[];
};

/** Run before PersistedState migration, installId(), or any first-run writes. */
export function decideDefaultModeCohort(
  memento: MementoLike, dir: string, fs: CohortFs,
  inspectDefaultMode: () => ConfigInspect<unknown> | undefined,
): DefaultModeCohort {
  const file = `${dir}/${DISK_KEYS[DEFAULT_MODE_COHORT_KEY]}`;
  const parse = (value: unknown): DefaultModeCohort => value === "new" ? "new" : "existing";
  const shadow = (value: DefaultModeCohort) => {
    try { void Promise.resolve(memento.update(DEFAULT_MODE_COHORT_KEY, value)).catch(() => {}); }
    catch { /* Disk remains authoritative when the host store is unavailable. */ }
    return value;
  };
  try {
    try { return shadow(parse(JSON.parse(fs.readFileSync(file, "utf8")))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const previous = memento.get(DEFAULT_MODE_COHORT_KEY);
    let cohort: DefaultModeCohort;
    if (previous !== undefined) cohort = parse(previous);
    else {
      let files: string[] = [];
      try { files = fs.readdirSync(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const config = inspectDefaultMode();
      const keys = new Set([...Object.keys(DISK_KEYS), MUSE_MODE_PREF_KEY, "grok.projectsInit", ...(memento.keys?.() ?? [])]);
      const used = files.length > 0
        || [...keys].some(key => key !== DEFAULT_MODE_COHORT_KEY && memento.get(key) !== undefined)
        || [config?.globalValue, config?.workspaceValue, config?.workspaceFolderValue].some(value => value !== undefined);
      cohort = used ? "existing" : "new";
    }
    fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify(cohort), { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another client decided first. Never overwrite its machine-wide choice.
      cohort = parse(JSON.parse(fs.readFileSync(file, "utf8")));
    }
    return shadow(cohort);
  } catch {
    // A failed read/write must never opt an uncertain install into more access.
    return shadow("existing");
  }
}
