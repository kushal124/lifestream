import { isObject, type InputRecord, type Json, type JsonObject, type MailAdapter, type MailItem } from "@lifestreamprotocol/connect/sdk";

export const mailAdapter: MailAdapter = {
  version: "1",
  kinds: ["mailmsg"],
  owner: "account",
  mail({ version }: InputRecord, header: (name: string) => string | null): MailItem {
    const record = version.content;
    const pulled = isObject(record) && isObject(record.content) ? record.content : {};
    const thread = typeof pulled.gm_thrid === "string" ? pulled.gm_thrid : header("x-gm-thrid")?.trim() ?? null;
    return { blob: originalBlob(record), exported: typeof pulled.from_line === "string", thread, ...filed(pulled, header) };
  },
};

function filed(pulled: JsonObject, header: (name: string) => string | null): { junk: string | null; draft: boolean } {
  const folder = typeof pulled.folder === "string" ? pulled.folder.toLowerCase() : "";
  if (folder === "spam" || folder.endsWith("/spam")) return { junk: "Spam", draft: false };
  if (folder === "trash" || folder.endsWith("/trash")) return { junk: "Trash", draft: false };
  const labels = Array.isArray(pulled.labels)
    ? pulled.labels.filter((label): label is string => typeof label === "string")
    : (header("x-gmail-labels") ?? "").split(",").map((label) => label.trim()).filter(Boolean);
  const words = labels.map((label) => label.replace(/^\\/u, "").toLowerCase());
  const draft = words.includes("draft") || words.includes("drafts");
  for (const word of words) {
    if (word === "spam" || word === "trash" || word === "chat") return { junk: word[0]!.toUpperCase() + word.slice(1), draft };
  }
  return { junk: null, draft };
}

function originalBlob(record: Json): string | null {
  if (!isObject(record) || !Array.isArray(record.blobs) || record.blobs.length !== 1) return null;
  const blob = record.blobs[0];
  return isObject(blob) && blob.role === "original" && blob.media_type === "message/rfc822" && typeof blob.hash === "string" ? blob.hash : null;
}
