import type { Dependencies, FakeFolder, ImapClient } from "../shared/dependencies.js";

export type Login = "ok" | "refused" | "cut" | "hang";

export type ImapCommand = "connect" | "list" | "mailboxOpen" | "search" | "fetch";

export type FakeImap = ReturnType<typeof fakeImap>;

const inSet = (range: string, uid: number): boolean =>
  range.split(",").some((part) => {
    const [low, high = low] = part.split(":").map((end) => (end === "*" ? Infinity : Number(end)));
    return uid >= low! && uid <= high!;
  });

export const refusedWith = (code: string, text: string): Error =>
  Object.assign(new Error("Command failed"), {
    response: { tag: "A12", command: "NO", attributes: [{ type: "ATOM", value: "", section: [{ type: "ATOM", value: code }] }, { type: "TEXT", value: text }] },
    responseStatus: "NO",
    responseText: text,
    executedCommand: "A12 UID FETCH",
  });

export const loginRefused = (typed: string): Error =>
  Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", response: `2 NO [AUTHENTICATIONFAILED] Invalid credentials ${typed} (Failure)` });

export function fakeImap(folders: Record<string, FakeFolder>) {
  const asked: string[] = [];
  let open: string | undefined;
  let afterOpen: (() => void) | undefined;
  let connection: { account: string; password: string } | undefined;
  const state: { refuseSearch: boolean; fail?: { after: number; error: Error } } = { refuseSearch: false };
  const command = (name: ImapCommand) => api.before?.(name);
  const client: ImapClient = {
    async connect() {
      command("connect");
      if (api.login === "hang") return new Promise<void>(() => undefined);
      if (api.login === "cut") throw Object.assign(new Error("Connection not available"), { authenticationFailed: true, code: "NoConnection", response: false });
      const typed = connection?.password ?? "";
      if (api.login === "refused" || (api.password !== undefined && typed !== api.password)) throw loginRefused(typed);
    },
    async logout() {},
    close() {
      api.closes++;
    },
    async list() {
      command("list");
      return Object.entries(folders).map(([path, folder]) => ({ path, ...(folder.specialUse === undefined ? {} : { specialUse: folder.specialUse }) }));
    },
    async mailboxOpen(path, options) {
      command("mailboxOpen");
      if (options.readOnly !== true) throw new Error("a mailbox is opened read-only");
      const folder = folders[path] ?? (() => { throw refusedWith("NONEXISTENT", `Unknown Mailbox: ${path} (Failure)`); })();
      open = path;
      const selected = { uidValidity: BigInt(folder.uidValidity), uidNext: folder.uidNext };
      afterOpen?.();
      return selected;
    },
    async search(query) {
      command("search");
      asked.push(`${open} SEARCH UID ${query.uid}${query.since === undefined ? "" : ` SINCE ${query.since.toISOString().slice(0, 10)}`}`);
      if (state.refuseSearch) {
        state.refuseSearch = false;
        return false;
      }
      const day = query.since?.toISOString().slice(0, 10);
      return folders[open!]!.messages.filter((entry) => inSet(query.uid, entry.uid) && (day === undefined || entry.internalDate!.toISOString().slice(0, 10) >= day)).map((entry) => entry.uid);
    },
    async *fetch(range, query) {
      command("fetch");
      const all = folders[open!]!.messages;
      if ("size" in query) {
        const dated = query.internalDate === true;
        asked.push(`${open} SIZE${dated ? " INTERNALDATE" : ""} ${range}`);
        for (const entry of all.filter((each) => inSet(range, each.uid))) {
          yield { uid: entry.uid, size: entry.source!.length, ...(dated && entry.internalDate !== undefined ? { internalDate: entry.internalDate } : {}) };
        }
        return;
      }
      asked.push(`${open} ${range}`);
      const inside = all.filter((entry) => inSet(range, entry.uid));
      const failing = state.fail;
      delete state.fail;
      for (const [index, entry] of (inside.length > 0 || !range.endsWith(":*") ? inside : all.slice(-1)).entries()) {
        if (failing !== undefined && index === failing.after) throw failing.error;
        yield entry;
      }
      if (failing !== undefined && failing.after >= inside.length) throw failing.error;
    },
  };
  const api = {
    asked,
    folders,
    login: "ok" as Login,
    password: undefined as string | undefined,
    logins: [] as { account: string; password: string }[],
    closes: 0,
    client,
    before: undefined as ((command: ImapCommand) => void) | undefined,
    imap: ((made: { account: string; password: string }) => {
      connection = { account: made.account, password: made.password };
      api.logins.push(connection);
      return client;
    }) as NonNullable<Dependencies["imap"]>,
    failNext(after: number, error: Error) {
      state.fail = { after, error };
    },
    refuseNextSearch() {
      state.refuseSearch = true;
    },
    onNextOpen(work: () => void) {
      afterOpen = () => {
        afterOpen = undefined;
        work();
      };
    },
  };
  return api;
}
