import { isInternalProvider, type AcpProvider } from "./acp-backend";

export const MODEL_PINS_KEY = "grok.modelPins";

export interface ModelPin {
  provider: AcpProvider;
  modelId: string;
  pinnedAt: number;
}

export type ModelPins = Record<string, ModelPin>;

export function isModelPinId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseModelPins(value: unknown): ModelPins {
  const pins: ModelPins = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return pins;
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { provider, modelId, pinnedAt } = entry as Partial<Record<keyof ModelPin, unknown>>;
    if (isInternalProvider(provider) && isModelPinId(modelId) && key === `${provider}:${modelId}`
      && typeof pinnedAt === "number" && Number.isSafeInteger(pinnedAt) && pinnedAt >= 0) {
      pins[key] = { provider, modelId, pinnedAt };
    }
  }
  return pins;
}

export function orderedModelPins(pins: ModelPins): ModelPin[] {
  // Stable sort keeps the record's insertion order for equally stamped pins.
  return Object.values(pins).sort((a, b) => a.pinnedAt - b.pinnedAt);
}

export function toggleModelPin(
  pins: ModelPins, provider: AcpProvider, modelId: string, pinned: boolean, now: number,
): ModelPins {
  const key = `${provider}:${modelId}`;
  if (Object.hasOwn(pins, key) === pinned) return pins;
  let next = { ...pins };
  if (!pinned) {
    delete next[key];
    return next;
  }

  const ordered = orderedModelPins(pins);
  let last = ordered.at(-1)?.pinnedAt ?? -1;
  if (last === Number.MAX_SAFE_INTEGER) {
    // Recover from a maxed-out stored timestamp without losing its position.
    next = Object.fromEntries(ordered.map((pin, pinnedAt) =>
      [`${pin.provider}:${pin.modelId}`, { ...pin, pinnedAt }]));
    last = ordered.length - 1;
  }
  next[key] = { provider, modelId, pinnedAt: Math.max(now, last + 1) };
  return next;
}
