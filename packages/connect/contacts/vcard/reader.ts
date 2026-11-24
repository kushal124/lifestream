import { createHash } from "node:crypto";
import { archive, consuming, each, forThisAccount, isObject, refuse, streamCards, type Guard, type Member, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

const contact: Guard = (content) => {
  if (!isObject(content) || Object.keys(content).sort().join(",") !== "card,type") return ["content must hold exactly type and card"];
  const out: string[] = [];
  if (content.type !== "contacts.card") out.push("type must be contacts.card");
  if (typeof content.card !== "string") out.push("card must be the card's text");
  return out;
};

export const contactsVcard: Reader = {
  name: "contacts-vcard",
  kinds: { contact },
  async *read(delivery, files) {
    if (!forThisAccount(delivery)) return;
    const imported = delivery.facts.import !== undefined;
    let read: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, (members) => {
      read = members.filter((member) => (imported ? TAKEOUT_CONTACTS : VCF).test(member.name));
      return cards(read);
    }), () => read);
  },
};

const VCF = /\.vcf$/iu;
const TAKEOUT_CONTACTS = /(?:^|\/)Takeout\/Contacts\/[^/]+\/[^/]+\.vcf$/iu;

async function* cards(exports: readonly Member[]): AsyncGenerator<ReaderOutput> {
  if (exports.length === 0) refuse("the delivery holds no .vcf export");
  yield* each(exports, (file) => file.where, async function* (file): AsyncGenerator<ReaderOutput> {
    for await (const card of streamCards(file.chunks(), file.where)) {
      yield {
        kind: "contact",
        key: createHash("sha256").update(card.bytes).digest("hex"),
        content: { type: "contacts.card", card: card.bytes.toString("utf8") },
        locator: `${file.where}:byte ${card.start}`,
      };
    }
  });
}
