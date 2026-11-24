import {
  each, instantOf, isObject, readJson, spanOf, utf8,
  type Acquirer, type Adapters, type Connector, type Dependencies, type InputRecord, type Note as Read, type NotesAdapter, type Reader, type ReaderOutput,
} from "@lifestreamprotocol/connect/sdk";
import { FLAWS, notesAcquirer } from "./acquirers.js";

interface Note {
  id: string;
  created_at: string;
  updated_at: string;
  day?: string;
  due?: string;
}

function reader(id: string): Reader {
  return {
    name: id,
    kinds: { note: (content) => (isObject(content) && typeof content.id === "string" ? [] : ["a note has an id"]) },
    async *read(delivery, files) {
      yield* each(delivery.files, (file) => file.path, (file): ReaderOutput[] => {
        const note = readJson(utf8(files.bytes(file.blob), file.path), file.path) as unknown as Note;
        const created = instantOf(note.created_at, "rfc3339", `${file.path} created_at`);
        const updated = instantOf(note.updated_at, "rfc3339", `${file.path} updated_at`);
        const time = note.day !== undefined ? instantOf(note.day, "date", `${file.path} day`)
          : note.due !== undefined ? instantOf(note.due, "rfc3339", `${file.path} due`)
          : updated.start_ms > created.start_ms ? spanOf(created, updated, file.path) : created;
        return [{ kind: "note", key: note.id, content: note as never, time, locator: file.path }];
      });
    },
  };
}

const notesAdapter: NotesAdapter = {
  version: "1", kinds: ["note"],
  note: (record: InputRecord): Read | null => {
    const content = record.version.content;
    return isObject(content) && typeof content.title === "string" ? { shape: "note", title: content.title, text: content.title, locked: false, trashed: false, marked: false } : null;
  },
};

const notes = (id: string): Connector => {
  const flaws = FLAWS[id]!;
  return {
    id, product: id, name: "Synthetic notes", vendor: "synthetic", type: "notes", noun: ["note", "notes"], records: "Every note's title.",
    sources: [{ id: `${id}:<account>:cloud`, read: id, arrives: "poll" }],
    acquirers: [id],
    refresh: { default: "5m", min: "1m" },
    ...(flaws.noPage ? {} : { backfill: { about: "Collects the notes already in your account, a batch at a time." } }),
    fields: {
      account: { kind: "email", label: "Synthetic email", account: true },
      ...(flaws.open ? {} : flaws.oauth ? { signin: { kind: "secret", label: "Synthetic sign-in", secret: `${id}.signin` } } : { key: { kind: "secret", label: "API key", secret: `${id}.key` } }),
    },
    ...(flaws.oauth ? {
      signin: [{
        acquirer: id, way: "client", field: "signin", client: "synthetic", scope: "notes.read", label: "Sign in with Synthetic",
        check: { url: "https://api.example.com/v1/me", account: "email" },
      }],
    } : {}),
  } as Connector;
};

const ids = Object.keys(FLAWS);

export const contract = 3;
export const connectors: readonly Connector[] = Object.keys(FLAWS).map(notes);
export const readers: Reader[] = ids.map(reader);
export const adapters: Record<string, Adapters> = Object.fromEntries(ids.map((id) => [id, { notes: notesAdapter }]));
export const acquirers: Record<string, (settings: never, dependencies?: Dependencies) => Acquirer> = Object.fromEntries([
  ...Object.keys(FLAWS).map((id) => [id, notesAcquirer(id)]),
]);
