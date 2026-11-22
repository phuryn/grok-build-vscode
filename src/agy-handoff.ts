export const AGY_HANDOFF_MARKER = "[AFK Pilot: earlier conversation]";

export function isAgyHandoff(text: unknown): boolean {
  return typeof text === "string" && text.startsWith(AGY_HANDOFF_MARKER);
}
