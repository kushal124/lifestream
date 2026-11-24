import { StationFailed } from "./station.js";

const UNREACHED = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH",
  "EHOSTDOWN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT",
  "NoConnection", "EConnectionClosed", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT",
]);

const DOOR = new Set(["NO_DOOR", "NOT_NOW"]);

function uncarried(error: unknown): "door" | "network" | null {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 5; at = at.cause, depth++) {
    if (at instanceof StationFailed) return DOOR.has(at.code) ? "door" : at.code === "OFFLINE" ? "network" : null;
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && UNREACHED.has(code)) return "network";
    if (at.message === "fetch failed" || at.message === "Unexpected close") return "network";
  }
  return null;
}

export function byDoor(error: unknown): boolean {
  return uncarried(error) === "door";
}

/** Whether an error, or one of the errors that caused it, says the network or the home's door could not be reached. */
export function offline(error: unknown): boolean {
  return uncarried(error) !== null;
}
