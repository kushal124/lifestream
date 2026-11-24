import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { idType, linkParts, looksLikeToken, ruleMarks } from "./rules.js";
import type { Links } from "@lifestreamprotocol/core";

const artifact: Record<string, Record<Links, string>> = {};
afterAll(() => writeFileSync(join(tmpdir(), "privacy-rules.json"), `${JSON.stringify(artifact, null, 2)}\n`));

function found(text: string, links: Links = "tokens"): string[] {
  return ruleMarks(text, links).marks.map((mark) => `${mark.type} ${text.slice(mark.start, mark.end)}`);
}

function hiddenLink(link: string, links: Links): string {
  const parts = linkParts(link, links).hidden.sort((left, right) => right.start - left.start);
  let out = link;
  for (const part of parts) out = `${out.slice(0, part.start)}[…]${out.slice(part.end)}`;
  return out;
}

describe("the rules", () => {
  it("find each shape they were taught, as finely as they know it", () => {
    const text = [
      "Card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, IFSC HDFC0001234, A/c no: 50100012345678.",
      "Card ending in 4821, account XX9911, PAN ABCPE1234F, GSTIN 22ABCPE1234F1Z5, Aadhaar 2345 6789 0124, SSN 123-45-6789.",
      "Order #99812. Pay ada.example@okaxis or 0x52908400098527886E0F7030069857D2E4169EE7.",
      "Key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt123, password: hunter2!, your OTP is 482913, 774411 is your code.",
      "At 12.97160, 77.59460 in /Users/adaex/Documents, ada@macbook-pro-0001:~$ ls",
    ].join("\n");
    const marks = found(text);
    for (const expected of [
      "number.card 4111 1111 1111 1111", "number.bank GB82 WEST 1234 5698 7654 32", "number.bank HDFC0001234", "number.bank 50100012345678",
      "number 4821", "number XX9911", "number.tax ABCPE1234F", "number.tax 22ABCPE1234F1Z5", "number.government 2345 6789 0124", "number.government 123-45-6789",
      "number.order 99812", "number.payment ada.example@okaxis", "number.payment 0x52908400098527886E0F7030069857D2E4169EE7",
      "secret sk-ant-api03-AbCdEfGhIjKlMnOpQrSt123", "secret hunter2!", "secret 482913", "secret 774411",
      "place 12.97160, 77.59460", "account adaex", "account ada",
    ]) expect(marks).toContain(expected);
  });

  it("find phones in international, Indian and national shapes, and ids typed by their form", () => {
    const text = "Call +1 555 000 0001, 0044 20 7946 0000, 98765 43210 or (555) 000-0002; mail person-a@example.com; chat 15550000001@s.whatsapp.net and 15550000002@lid.";
    const marks = found(text);
    for (const expected of [
      "phone +1 555 000 0001", "phone 0044 20 7946 0000", "phone 98765 43210", "phone (555) 000-0002",
      "email person-a@example.com", "phone 15550000001@s.whatsapp.net", "phone 15550000002@lid",
    ]) expect(marks).toContain(expected);
  });

  it("take no number that fails its check with no label before it, and no ordinary words", () => {
    expect(found("Card 4111 1111 1111 1112, then GB83 WEST 1234 5698 7654 32, and 2345 6789 0125, the order was confirmed, password is long")).toEqual([]);
    expect(found("We met at 4 pm on 2026-11-11; it cost 1,250 and took 3.5 hours.")).toEqual([]);
  });

  it("take a number after its label though it fails its check: the label says what it is", () => {
    expect(found("IBAN GB83 WEST 1234 5698 7654 32, Aadhaar 2345 6789 0125")).toEqual(["number.government 2345 6789 0125", "number.bank GB83 WEST 1234 5698 7654 32"]);
  });

  it("type an id from its form alone", () => {
    expect(idType("15550000001@s.whatsapp.net")).toBe("phone");
    expect(idType("15550000001-1600000000@g.us")).toBe("phone");
    expect(idType("ada.example@lid")).toBe("account");
    expect(idType("Person-A@Example.com")).toBe("email");
    expect(idType("+1 (555) 000-0001")).toBe("phone");
    expect(idType("15550000001")).toBe("phone");
    expect(idType("@adaex")).toBe("account");
    expect(idType("57575")).toBe("account");
    expect(idType("ada.example@okaxis")).toBe("number.payment");
    expect(idType("9876500123@ybl")).toBe("number.payment");
  });
});

describe("links", () => {
  const SET: { name: string; link: string; tokens: string; path: string }[] = [
    { name: "password reset", link: "https://accounts.example.com/reset/8f3k2q9xw7v1/confirm?u=4417&t=zz", tokens: "https://accounts.example.com/reset/[…]/confirm?[…]", path: "https://accounts.example.com/[…]" },
    { name: "magic sign-in", link: "https://app.example.com/auth/magic?token=Zx81Kq0PlmN3vB7c&email=person-a%40example.com", tokens: "https://app.example.com/auth/magic?[…]", path: "https://app.example.com/[…]" },
    { name: "shared document", link: "https://docs.example.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit?usp=sharing", tokens: "https://docs.example.com/document/d/[…]/edit?[…]", path: "https://docs.example.com/[…]" },
    { name: "unsubscribe", link: "https://mail.example.com/unsubscribe/eyJ1IjoiNDQxNyJ9a8Qz", tokens: "https://mail.example.com/unsubscribe/[…]", path: "https://mail.example.com/[…]" },
    { name: "an id in the path", link: "https://shop.example.com/orders/40417795512/track", tokens: "https://shop.example.com/orders/[…]/track", path: "https://shop.example.com/[…]" },
    { name: "a uuid in the path, a fragment", link: "https://app.example.com/invite/550e8400-e29b-41d4-a716-446655440000#k=Qx9", tokens: "https://app.example.com/invite/[…]#[…]", path: "https://app.example.com/[…]" },
    { name: "a sign-in part", link: "https://ada:hunter2@files.example.com/share/report", tokens: "https://[…]@files.example.com/share/report", path: "https://[…]@files.example.com/[…]" },
    { name: "a plain article", link: "https://news.example.com/2026/11/how-to-hide-details", tokens: "https://news.example.com/2026/11/how-to-hide-details", path: "https://news.example.com/[…]" },
    { name: "a host alone", link: "https://example.com/", tokens: "https://example.com/", path: "https://example.com/" },
  ];

  for (const { name, link, tokens, path } of SET) {
    it(`hide a ${name} as each setting says, the host always kept`, () => {
      artifact[name] = { tokens: hiddenLink(link, "tokens"), path: hiddenLink(link, "path"), none: hiddenLink(link, "none") };
      expect(artifact[name]).toEqual({ tokens, path, none: link });
    });
  }

  it("mark each hidden part of a link in text as one link mark, and leave a sentence's stop out of the link", () => {
    const text = "Reset at https://accounts.example.com/reset/8f3k2q9xw7v1/confirm?u=4417&t=zz. Then (see https://example.com/a/40417795512).";
    expect(found(text).filter((mark) => mark.startsWith("link"))).toEqual(["link 8f3k2q9xw7v1", "link u=4417&t=zz", "link 40417795512"]);
  });

  it("under none, mark nothing of a link's own and still mark a detail inside it", () => {
    const text = "Open https://example.com/share/40417795512?to=person-a@example.com now";
    expect(found(text, "none")).toEqual(["email person-a@example.com"]);
    expect(ruleMarks(text, "tokens").soft.map((span) => text.slice(span.start, span.end))).toEqual(["share"]);
  });

  it("call a segment a token by its pieces: long numbers, letters mixed with digits, long mixed case", () => {
    expect(["8f3k2q9xw7v1", "40417795512", "ada-example-3a9f2b", "kJhGfDsAqWeRtYuIo", "a%2F8f3k2q9xw7v1"].every(looksLikeToken)).toBe(true);
    expect(["reset", "confirm", "2026", "how-to-hide-details", "html5", "in", "ada"].some(looksLikeToken)).toBe(false);
  });
});
