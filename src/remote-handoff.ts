import qrcode from "qrcode-generator";
import { httpBaseFromRelayUrl } from "./remote-frames";
import { pathsEqual } from "./worktree";

export interface HandoffSession {
  id: string;
  repoCwd: string;
  cwd: string;
  title: string;
}

/** Session coordinates stay in the fragment: they never enter an HTTP request. */
export function remoteHandoffUrl(relayUrl: string, deviceId: string | undefined, session?: HandoffSession): string | undefined {
  if (!deviceId || !session?.id || !session.repoCwd || !session.cwd) return undefined;
  const fragment = `session=${encodeURIComponent(session.id)}&repo=${encodeURIComponent(session.repoCwd)}`
    + (pathsEqual(session.cwd, session.repoCwd) ? "" : `&cwd=${encodeURIComponent(session.cwd)}`);
  return `${httpBaseFromRelayUrl(relayUrl)}/chat?device=${encodeURIComponent(deviceId)}#${fragment}`;
}

/** Host-only encoder. Four-module quiet zone; no title or URL inserted as SVG markup. */
export function remoteHandoffQr(url: string): string {
  const code = qrcode(0, "M");
  code.addData(url, "Byte");
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}
