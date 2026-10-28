/**
 * File-backed MementoLike + secrets for the desktop host.
 * Synchronous reads (PersistedState requires it); async updates.
 * Profile writes use the same atomic rename path as secrets/config.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MementoLike } from "../persisted-state";
import type { HostSecrets } from "../host";
import { writeFileAtomic } from "./safe-secrets";

function readJsonMap(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJsonMap(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

export function createFileMemento(filePath: string): MementoLike {
  let cache = readJsonMap(filePath);
  return {
    keys: () => Object.keys(cache),
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (Object.prototype.hasOwnProperty.call(cache, key)) {
        return cache[key] as T;
      }
      return arguments.length >= 2 ? defaultValue : undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) delete cache[key];
      else cache[key] = value;
      writeJsonMap(filePath, cache);
    },
  };
}

export function createFileSecrets(filePath: string): HostSecrets {
  let cache = readJsonMap(filePath) as Record<string, string>;
  const persist = () => writeJsonMap(filePath, cache);
  return {
    async get(key: string) {
      cache = readJsonMap(filePath) as Record<string, string>;
      const v = cache[key];
      return typeof v === "string" ? v : undefined;
    },
    async store(key: string, value: string) {
      cache[key] = value;
      persist();
    },
    async delete(key: string) {
      delete cache[key];
      persist();
    },
  };
}
