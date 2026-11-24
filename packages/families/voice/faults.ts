import { SHA256_HEX, type Recording, type VoiceAdapter } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";

export function voiceFaults({ member, value }: Stated<VoiceAdapter>): string[] {
  if (member !== "recording" || value === null || typeof value !== "object") return [];
  const recording = value as Recording;
  const faults: string[] = [];
  if (typeof recording.sha256 !== "string" || !SHA256_HEX.test(recording.sha256)) faults.push(`\`sha256\` is 64 lower-case hex digits, no \`sha256:\`: ${quoted(recording.sha256)} is none`);
  if (!(recording.ended_ms >= recording.started_ms)) faults.push(`\`ended_ms\` is at or after \`started_ms\`: ${recording.ended_ms} is before ${recording.started_ms}`);
  return faults;
}
