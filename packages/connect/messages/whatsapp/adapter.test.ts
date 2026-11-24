import type { Json, SourceRow, Version } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { whatsappMessages } from "./adapter-messages.js";

describe("WhatsApp's adapters", () => {
  it("a chat's spelling read as another network's: a group by its id, a one-to-one chat by its partner, a phone JID shown as its hidden-number id", () => {
    expect([whatsappMessages.group("120363000000000001@g.us"), whatsappMessages.group("15550000001@s.whatsapp.net")]).toEqual([true, false]);
    expect(whatsappMessages.members("120363000000000001@g.us")).toEqual([]);
    expect(whatsappMessages.members("99990000001@lid")).toEqual([{ id: "99990000001@lid", kind: "jid" }]);
    const aliases = () => ["99990000001@lid"];
    expect(whatsappMessages.shown!("15550000001@s.whatsapp.net", aliases)).toBe("99990000001@lid");
    const unread = () => expect.unreachable("aliases read");
    expect([whatsappMessages.shown!("99990000001@lid", unread), whatsappMessages.shown!("120363000000000001@g.us", unread)]).toEqual(["99990000001@lid", "120363000000000001@g.us"]);
  });

  it("the images a message carries read otherwise than the faces labeler reads them: a status post's photo, or a file of a kind it reads no face on", () => {
    const blob = `sha256:${"a".repeat(64)}`;
    const record = (key: string, message: Record<string, Json>, session = "15550000002@s.whatsapp.net", media: Json = null) => ({
      source: { id: "whatsapp:15550000000:macbook-pro-0001", product: "whatsapp", account: "15550000000", copy: "macbook-pro-0001" } as SourceRow,
      version: { kind: "msg", key, content: { type: "whatsapp.msg", session_jid: session, message, media_item: media, blobs: [{ hash: blob, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }] } } as unknown as Version,
    });
    expect(whatsappMessages.images!(record("15550000002@s.whatsapp.net:M1", { ZMESSAGETYPE: 1, ZISFROMME: 0, ZFROMJID: "15550000002@s.whatsapp.net" })))
      .toEqual({ blobs: [blob], sender: { kind: "jid", value: "15550000002@s.whatsapp.net" } });
    expect(whatsappMessages.images!(record("15550000002@s.whatsapp.net:M2", { ZMESSAGETYPE: 15, ZISFROMME: 1 }))).toEqual({ blobs: [blob], sender: null });
    expect(whatsappMessages.images!(record("120363000000000001@g.us:M3", { ZMESSAGETYPE: 20, ZISFROMME: 0 }, "120363000000000001@g.us"))).toEqual({ blobs: [blob], sender: null });
    const status = record("status@broadcast:M4", { ZMESSAGETYPE: 1, ZISFROMME: 0, ZFROMJID: "15550000002@s.whatsapp.net" }, "status@broadcast");
    expect([whatsappMessages.message(status), whatsappMessages.images!(status)]).toEqual([null, { blobs: [blob], sender: null }]);
    const gif = record("15550000002@s.whatsapp.net:M5", { ZMESSAGETYPE: 11, ZISFROMME: 0 }, undefined, { ZVCARDSTRING: "image/gif" });
    expect([whatsappMessages.message(gif)?.parts.map((part) => part.what), whatsappMessages.images!(gif)]).toEqual([["photo"], null]);
  });

  it("a business the app lists names or pairs someone, or loses an id or its level", () => {
    const label = (content: Record<string, Json>) => whatsappMessages.label!({ version: { kind: "business", key: "90000000000041@lid", content: { type: "whatsapp.business", ...content } } } as never);
    expect(label({ ZJID: "90000000000041@LID", ZPHONENUMBERJID: "15550000041@s.whatsapp.net", ZNAME: "Example Shop", ZVERIFICATIONLEVEL: 3 }))
      .toEqual({ names: [], business: { ids: ["90000000000041@lid", "15550000041@s.whatsapp.net"], level: 3, name: "Example Shop" } });
    expect(label({ ZJID: "90000000000042@lid", ZPHONENUMBERJID: null, ZNAME: " ", ZVERIFICATIONLEVEL: 1 })).toEqual({ names: [], business: { ids: ["90000000000042@lid"], level: 1 } });
    expect(label({ ZJID: "90000000000043@lid", ZPHONENUMBERJID: null, ZNAME: null, ZVERIFICATIONLEVEL: null })).toEqual({ names: [] });
    expect(whatsappMessages.labels!.kinds).toContain("business");
    expect(whatsappMessages.labelText!({ version: { kind: "business", content: { type: "whatsapp.business", ZJID: "90000000000041@lid", ZPHONENUMBERJID: null, ZNAME: " Example Shop ", ZVERIFICATIONLEVEL: 3 } } } as never))
      .toEqual({ title: "Example Shop", who: ["90000000000041@lid"] });
  });

  it("a handle named in its labels by another id than its JID, or an account read as no own phone", () => {
    expect([whatsappMessages.labelId!({ kind: "phone", value: "+15550000001" }), whatsappMessages.labelId!({ kind: "jid", value: "99990000001@lid" }), whatsappMessages.labelId!({ kind: "email", value: "person-a@example.com" })])
      .toEqual(["15550000001@s.whatsapp.net", "99990000001@lid", null]);
    expect([whatsappMessages.self!("15550000000"), whatsappMessages.self!("person-a@example.com")]).toEqual(["15550000000@s.whatsapp.net", null]);
  });
});
