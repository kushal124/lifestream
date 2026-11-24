import { SHA256_HEX, type Copy, type PhotoFile, type PhotosAdapter } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";

export function photosFaults({ member, value }: Stated<PhotosAdapter>): string[] {
  const hexes = (at: string, given: unknown): string[] => (Array.isArray(given) ? given as unknown[] : []).flatMap((hex) =>
    typeof hex === "string" && SHA256_HEX.test(hex) ? [] : [`each of \`${at}\` is a SHA-256 in 64 lower-case hex digits, no \`sha256:\`: ${quoted(hex)} is none`]);
  const shas = (at: string, given: unknown): string[] => hexes(`${at}[].sha256`, (Array.isArray(given) ? given as PhotoFile[] : []).map((file) => file?.sha256));
  switch (member) {
    case "files":
      return hexes("files", value);
    case "image":
      return value === null ? [] : hexes("image", [value]);
    case "copy": {
      if (value === null || typeof value !== "object") return [];
      const copy = value as Copy;
      return [
        ...shas("originals", copy.originals), ...shas("renders", copy.renders),
        ...shas("motion.originals", copy.motion?.originals), ...shas("motion.renders", copy.motion?.renders),
        ...hexes("files", copy.files),
        ...(Array.isArray(copy.resources) ? copy.resources : []).flatMap((resource) => hexes("resources[].files", resource?.files)),
      ];
    }
    default:
      return [];
  }
}
