import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { aiFamily, type ConversationDay } from "./ai/family.js";
import { dayAtoms } from "./days.js";
import { messagesFamily, type ChatDay } from "./messages/family.js";
import type { Fact } from "./messages/read.js";
import { photosFamily, type BurstContent, type BurstPhoto } from "./photos/family.js";
import { dayInput } from "./test/day-input.js";
import { FED } from "./test/fed.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const DAY = "2026-10-25";
const at = (local: string) => Date.parse(`${DAY}T${local}-04:00`);
const IMAGE_1 = `sha256:${"1".repeat(64)}`;
const IMAGE_2 = `sha256:${"2".repeat(64)}`;
const VOICE = `sha256:${"3".repeat(64)}`;

describe("a line states its chat and its pictures", () => {
  it("C1 a message states its chat, and the pictures it holds whose bytes the home holds", () => {
    const family = messagesFamily({ books: FED.labels })(FED.messages);
    const source = "imessage:person-a@example.com:macbook-pro-0001";
    const messages: Fact[] = [
      {
        source, key: "M1", at: at("09:00"), from: { id: "+15550000001", kind: "phone" }, text: "the lantern photos",
        parts: [
          { what: "photo", blob: IMAGE_1, media_type: "image/jpeg" }, { what: "photo", blob: IMAGE_2, media_type: "image/heic" },
          { what: "photo" }, { what: "voice note", blob: VOICE, media_type: "audio/mpeg" },
        ],
      },
      { source, key: "M2", at: at("09:05"), from: { id: "me", kind: "me" }, text: "lovely" },
    ];
    const content: ChatDay = { network: "imessage", chat: "+15550000001", day: DAY, messages };
    const input = dayInput(family, DAY, [{ unit: `${DAY}:imessage:+15550000001`, content, start_ms: messages[0]!.at, end_ms: messages[1]!.at }], SETTINGS);
    const atoms = dayAtoms(DAY, SETTINGS, family.name, family.day(input).lines);
    expect(atoms.map((atom) => [atom.record?.key, atom.chat, atom.pictures, atom.block?.key])).toEqual([
      ["M1", "imessage:+15550000001", 2, "imessage:+15550000001"],
      ["M2", "imessage:+15550000001", undefined, "imessage:+15550000001"],
    ]);
  });

  it("C2 an AI turn states its conversation as the door reads one whole, `<source>/<conversation>`", () => {
    const family = aiFamily(FED.ai);
    const source = "chatgpt:user-synthetic-aa01:export";
    const turn = (key: string, role: "user" | "assistant", words: string, at_ms: number) => ({ key, at_ms, role, words, attachments: [], images: 0, tools: [], documents: [] });
    const content: ConversationDay = { provider: "chatgpt", title: "Lantern route", turns: [turn("conv-1:t1", "user", "where are the lanterns", at("10:00")), turn("conv-1:t2", "assistant", "by the river", at("10:01"))] };
    const input = dayInput(family, DAY, [{ unit: `${source}/conv-1/${DAY}`, content, start_ms: at("10:00"), end_ms: at("10:01") }], SETTINGS);
    const atoms = dayAtoms(DAY, SETTINGS, family.name, family.day(input).lines);
    expect(atoms).toHaveLength(2);
    for (const atom of atoms) expect([atom.chat, atom.block?.key, atom.pictures]).toEqual([`${source}/conv-1`, `${source}/conv-1`, undefined]);
  });

  it("C3 a photo states the one picture it shows when the home holds its file, and none when it does not", () => {
    const family = photosFamily({ faces: false })(FED.photos);
    const photo = (id: string, at_ms: number, sha256: string | null): BurstPhoto => ({
      photo: `photos:local:macbook-pro-0001/${id}`, accounts: ["photos:local"], item: sha256 === null ? `photo:${id}` : `photo:${sha256}`, sha256, at_ms, media_type: sha256 === null ? null : "image/jpeg",
      kind: "photograph", held: sha256 !== null, position: null, faces: null, motion: null, duration_ms: null,
    });
    const content: BurstContent = { photos: [photo("p1", at("12:00"), "4".repeat(64)), photo("p2", at("12:01"), null)] };
    const input = dayInput(family, DAY, [{ unit: "burst/synthetic-1", content, start_ms: at("12:00"), end_ms: at("12:01") }], SETTINGS);
    const atoms = dayAtoms(DAY, SETTINGS, family.name, family.day(input).lines);
    expect(atoms.map((atom) => [atom.item, atom.pictures, atom.chat])).toEqual([[`photo:${"4".repeat(64)}`, 1, undefined], ["photo:p2", undefined, undefined]]);
  });
});
