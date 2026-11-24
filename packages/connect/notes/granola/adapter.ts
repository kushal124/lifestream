import { isObject, type InputRecord, type Meeting, type NotesAdapter } from "@lifestreamprotocol/connect/sdk";

export const notesAdapter: NotesAdapter = {
  version: "1",
  kinds: ["note"],
  note: ({ source, version }: InputRecord): Meeting | null => {
    const content = version.content;
    if (!isObject(content)) return null;
    const own = source.account.toLowerCase();
    const everyone: { name: string | null; email: string | null }[] = [];
    let title: string | null = null;
    const words: string[] = [];
    if (content.type === "granola.note" && isObject(content.note)) {
      const note = content.note;
      title = stated(note.title);
      for (const each of Array.isArray(note.attendees) ? note.attendees.filter(isObject) : []) everyone.push({ name: stated(each.name), email: stated(each.email) });
      words.push(...[note.summary_markdown ?? note.summary_text, note.private_notes_markdown ?? note.private_notes_text].flatMap((value) => stated(value) ?? []));
    } else if (content.type === "granola.mcp-note" && isObject(content.meeting)) {
      title = stated(content.meeting.title);
      const participants = isObject(content.known_participants) ? stated(content.known_participants.text) : null;
      everyone.push(...participantsOf(participants ?? ""));
      for (const member of ["summary", "private_notes"]) {
        const child = content[member];
        const said = isObject(child) ? stated(child.text) : null;
        if (said !== null) words.push(said);
      }
    } else {
      return null;
    }
    const others = everyone.filter((each) => each.email?.toLowerCase() !== own);
    return {
      shape: "meeting",
      title: title ?? "Untitled meeting",
      people: [...new Set(others.flatMap((each) => each.name ?? each.email ?? []))],
      emails: everyone.flatMap((each) => each.email ?? []),
      words,
    };
  },
};

function participantsOf(text: string): { name: string | null; email: string | null }[] {
  return text.split(/,\s*(?![^()]*\))/u).map((entry) => entry.trim()).filter((entry) => entry !== "").map((entry) => {
    const parts = [...entry.matchAll(/\(([^()]*)\)/gu)].map((match) => match[1]!.trim());
    const name = entry.replace(/\([^()]*\)/gu, "").trim();
    return { name: name === "" ? null : name, email: parts.find((part) => /^[^\s@]+@[^\s@]+$/u.test(part)) ?? null };
  });
}

function stated(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
