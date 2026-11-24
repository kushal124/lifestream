import { instant, isObject, type Adapters, type Call, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import { canonicalEmail, canonicalPhone } from "@lifestreamprotocol/core";

type Party = Call["parties"][number];

export const appleCallsAdapter: NonNullable<Adapters["calls"]> = {
  version: "1",
  kinds: ["call"],
  network: "apple",
  services: { phone: "Phone call", "facetime-audio": "FaceTime audio call", "facetime-video": "FaceTime video call" },
  call: ({ version }) => readCall(version.content),
};

function readCall(content: Json): Call | null {
  if (!isObject(content) || !isObject(content.call) || !Array.isArray(content.handles)) return null;
  const call = content.call;
  if (typeof call.ZDATE !== "number") return null;
  let start_ms: number;
  try {
    start_ms = instant(call.ZDATE, "apple-s").start_ms;
  } catch {
    return null;
  }
  const seconds = typeof call.ZDURATION === "number" && call.ZDURATION > 0 ? call.ZDURATION : 0;
  const end = start_ms + Math.round(seconds * 1000);
  const direction = call.ZORIGINATED === 1 ? "outgoing" : "incoming";
  const connected = seconds > 0 || call.ZANSWERED === 1;
  const provider = typeof call.ZNAME === "string" && call.ZNAME.trim() !== "" ? call.ZNAME : null;
  return {
    service: call.ZSERVICE_PROVIDER === "com.apple.Telephony" ? "phone"
      : call.ZSERVICE_PROVIDER === "com.apple.FaceTime" ? (call.ZCALL_CATEGORY === 2 ? "facetime-video" : "facetime-audio")
      : "other",
    direction,
    outcome: connected ? "connected" : direction === "incoming" ? "missed" : "not-connected",
    start_ms,
    end_ms: end > start_ms ? end : null,
    parties: content.handles.flatMap((value: Json) => {
      const party = isObject(value) ? readHandle(value, provider) : null;
      return party === null ? [] : [party];
    }).sort((left, right) => compare(left.id, right.id)),
  };
}

function readHandle(handle: JsonObject, provider: string | null): Party | null {
  const spelling = text(handle.ZNORMALIZEDVALUE) ?? text(handle.ZVALUE);
  if (spelling === null) return null;
  const phone = handle.ZTYPE === 3 ? null : canonicalPhone(spelling);
  const email = phone !== null || handle.ZTYPE === 2 ? null : canonicalEmail(spelling);
  const named = provider === null ? {} : { provider };
  if (phone !== null) return { id: phone, kind: "phone", ...named };
  if (email !== null) return { id: email, kind: "email", ...named };
  return { id: spelling, kind: "raw", ...named };
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
