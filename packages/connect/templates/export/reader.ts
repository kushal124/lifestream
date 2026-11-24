import { archive, consuming, each, instantOf, isObject, readJson, refuse, sourceName, utf8, type Guard, type Member, type Reader, type ReaderOutput, wholeFiles } from "@lifestreamprotocol/connect/sdk";

export const NOTE = "note";
const ACCOUNT = /(?:^|\/)account\.json$/u;
const NOTES = /(?:^|\/)notes[^/]*\.json$/u;

const note: Guard = (content) =>
  isObject(content) && content.type === "example.note" && typeof content.id === "string" && typeof content.created_at === "string" ? [] : ["a note is { type: example.note, id, created_at, … }"];

const json = (member: Member) => readJson(utf8(member.bytes(), member.where), member.where);

export const exampleExport: Reader = {
  name: "example-export",
  kinds: { [NOTE]: note },
  account: { file: "account.json", json: (json) => (isObject(json) && typeof json.email === "string" ? json.email : refuse("account.json states no email: is it Example's download, as downloaded?")) },
  async *read(delivery, files) {
    let whole: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, async function* (members) {
      const accounts = members.filter((member) => ACCOUNT.test(member.name));
      if (accounts.length !== 1) refuse(accounts.length === 0 ? "the delivery holds no account.json" : `the delivery holds ${accounts.length} downloads' account.json`);
      const stated = json(accounts[0]!);
      const notes = members.filter((member) => NOTES.test(member.name));
      const email = isObject(stated) && typeof stated.email === "string" ? stated.email.toLowerCase() : undefined;
      if (email !== sourceName(delivery.source).account) refuse(`${accounts[0]!.where} names ${email ?? "no account"}, not ${delivery.source}'s`);
      yield* each(notes, (member) => member.where, (member) => {
        const items = json(member);
        if (!Array.isArray(items)) refuse(`${member.where} is not an array of notes`);
        return each(items, (_, index) => `${member.where}[${index}]`, (item): ReaderOutput[] => {
          if (!isObject(item) || typeof item.id !== "string" || item.id === "") refuse("a note states no id");
          if (Object.hasOwn(item, "type")) refuse(`note ${item.id} states a member type, which is the content's own`);
          return [{
            kind: NOTE, key: item.id, content: { type: "example.note", ...item },
            time: instantOf(String(item.created_at), "rfc3339", `note ${item.id} created_at`), locator: member.where,
          }];
        });
      });
      const read = new Set([accounts[0]!, ...notes]);
      whole = wholeFiles(members, (member) => read.has(member));
    }), () => whole);
  },
};
