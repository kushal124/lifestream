import { describe, expect, it } from "vitest";
import { artifact, collect, deliver, openTestHome } from "../../test/drive.js";
import { PULL_MANIFEST } from "./answers.js";
import { granola } from "./reader.js";
import { ACCOUNT, apiNote, apiPull, line, mcpPull, meetingElement, meetingsText, SOURCE, UUID_1, UUID_2, UUID_3 } from "./test/fixtures.js";

const STATED = Date.UTC(2026, 9, 27, 9);
const at = (iso: string) => Date.parse(iso);

const TRANSCRIBED = apiNote("not_00000000000001", UUID_1, {
  calendar_event: { event_title: "Synthetic", invitees: [{ email: "person-b@example.com" }], organiser: ACCOUNT, calendar_event_id: "event-1", scheduled_start_time: "2026-10-20T09:00:00.000Z", scheduled_end_time: "2026-10-20T10:00:00.000Z" },
  transcript: [line("2026-10-20T09:01:00.000Z", "2026-10-20T09:05:00.000Z", "Synthetic opening."), line("2026-10-20T09:05:00.000Z", "2026-10-20T09:34:30.000Z", "Synthetic close.", false)],
});
const SCHEDULED = apiNote("not_00000000000002", UUID_2, {
  calendar_event: { event_title: "Synthetic", invitees: [], organiser: ACCOUNT, calendar_event_id: "event-2", scheduled_start_time: "2026-10-21T14:00:00.000Z", scheduled_end_time: "2026-10-21T14:30:00.000Z" },
});
const BARE = apiNote("not_00000000000004", null, { created_at: "2026-10-22T08:15:00.000Z" });

describe("granola reader: each of these is impossible", () => {
  it("a note lands under another key or time, a paged transcript loses a page, or a note read twice writes a second version", async () => {
    const home = openTestHome();
    const pull = apiPull([
      { note: TRANSCRIBED },
      { note: SCHEDULED },
      { note: apiNote("not_00000000000003", UUID_3), pages: [[line("2026-10-23T09:00:00.000Z", "2026-10-23T09:10:00.000Z", "Synthetic page one.")], [line("2026-10-23T09:10:00.000Z", "2026-10-23T09:40:00.000Z", "Synthetic page two.", false)]] },
      { note: BARE },
    ]);
    const first = await home.land(granola, deliver(home, SOURCE, pull, {}, STATED));
    expect(first.refusals).toEqual([]);
    const heads = home.heads(SOURCE).map(({ kind, key, start_ms, end_ms }) => ({ kind, key, start_ms, end_ms }));
    expect(heads).toEqual([
      { kind: "note", key: UUID_1, start_ms: at("2026-10-20T09:01:00Z"), end_ms: at("2026-10-20T09:34:30Z") },
      { kind: "note", key: UUID_2, start_ms: at("2026-10-21T14:00:00Z"), end_ms: at("2026-10-21T14:30:00Z") },
      { kind: "note", key: UUID_3, start_ms: at("2026-10-23T09:00:00Z"), end_ms: at("2026-10-23T09:40:00Z") },
      { kind: "note", key: "not_00000000000004", start_ms: at("2026-10-22T08:15:00Z"), end_ms: null },
      { kind: "transcript", key: UUID_1, start_ms: at("2026-10-20T09:01:00Z"), end_ms: at("2026-10-20T09:34:30Z") },
      { kind: "transcript", key: UUID_3, start_ms: at("2026-10-23T09:00:00Z"), end_ms: at("2026-10-23T09:40:00Z") },
    ]);
    const note = home.heads(SOURCE, ["note"]).find((head) => head.key === UUID_1)!.content as { type: string; note: Record<string, unknown> };
    expect(note.type).toBe("granola.note");
    expect(Object.keys(note.note).sort()).toEqual(Object.keys(TRANSCRIBED).filter((name) => name !== "transcript").sort());
    const paged = home.heads(SOURCE, ["transcript"]).find((head) => head.key === UUID_3)!.content as { note: string; transcript: { text: string; speaker: unknown }[] };
    expect([paged.note, paged.transcript.map((each) => each.text)]).toEqual(["not_00000000000003", ["Synthetic page one.", "Synthetic page two."]]);
    expect(paged.transcript[1]!.speaker).toEqual({ source: "speaker", attribution: "them", diarization_label: "Speaker 2" });

    const again = await home.land(granola, deliver(home, SOURCE, pull, {}, STATED + 60_000));
    expect([again.changed, again.refusals]).toEqual([0, []]);
    expect(again.restated).toBe(6);
    artifact(home.dir, "heads.json", home.heads(SOURCE));
  });

  it("an attachment's renewed link makes a version, new bytes make none, or its link is kept", async () => {
    const home = openTestHome();
    const withImage = (url: string) => apiNote("not_00000000000005", UUID_1, { attachments: [{ id: "att_00000000000001", object: "attachment", type: "image", url, width: 640, height: 480 }] });
    await home.land(granola, deliver(home, SOURCE, apiPull([{ note: withImage("https://files.granola.example.com/a?signature=1"), attachments: { att_00000000000001: Buffer.from("synthetic bytes one") } }]), {}, STATED));
    const [first] = home.heads(SOURCE);
    const attachment = (first!.content as { note: { attachments: Record<string, unknown>[] } }).note.attachments[0]!;
    expect(attachment).toEqual({ id: "att_00000000000001", object: "attachment", type: "image", width: 640, height: 480, hash: `sha256:${(await import("node:crypto")).createHash("sha256").update("synthetic bytes one").digest("hex")}` });
    expect(home.blobs.bytes(attachment.hash as string).toString()).toBe("synthetic bytes one");

    const renewed = await home.land(granola, deliver(home, SOURCE, apiPull([{ note: withImage("https://files.granola.example.com/a?signature=2"), attachments: { att_00000000000001: Buffer.from("synthetic bytes one") } }]), {}, STATED + 60_000));
    expect([renewed.changed, home.heads(SOURCE)[0]!.version]).toEqual([0, first!.version]);
    const replaced = await home.land(granola, deliver(home, SOURCE, apiPull([{ note: withImage("https://files.granola.example.com/a?signature=3"), attachments: { att_00000000000001: Buffer.from("synthetic bytes two") } }]), {}, STATED + 120_000));
    expect(replaced.changed).toBe(1);
    expect(home.heads(SOURCE)[0]!.version).not.toBe(first!.version);
  });

  it("a deletion Granola states is not gone, or a note missing from a pull is", async () => {
    const home = openTestHome();
    await home.land(granola, deliver(home, SOURCE, apiPull([{ note: TRANSCRIBED }, { note: SCHEDULED }]), {}, STATED));
    await home.land(granola, deliver(home, SOURCE, apiPull([{ note: { ...TRANSCRIBED, deleted_at: "2026-10-26T10:00:00.000Z" } }]), {}, STATED + 60_000));
    expect(home.heads(SOURCE).map(({ kind, key, gone }) => `${kind} ${key} ${gone ? "gone" : "live"}`)).toEqual([`note ${UUID_1} gone`, `note ${UUID_2} live`, `transcript ${UUID_1} gone`]);
  });

  it("the same meeting by both routes is two records, an MCP answer's words around its meetings or a list or an error lands, or an event stream is not read", async () => {
    const home = openTestHome();
    const answers = mcpPull([
      { tool: "list_meetings", text: `<meetings_data count="1">${meetingElement(UUID_1)}</meetings_data>\n<pagination has_more="false" total_count="1" remaining_count="0" />` },
      { tool: "get_meetings", text: meetingsText([meetingElement(UUID_1, { notes: "Synthetic private note" }), meetingElement(UUID_2)]), media: "sse" },
      { tool: "get_meetings", text: "Upgrade to a paid plan to read this.", error: true },
    ]);
    const landed = await home.land(granola, deliver(home, SOURCE, answers, {}, STATED));
    expect(landed.refusals).toEqual([]);
    expect(home.heads(SOURCE).map(({ kind, key, start_ms }) => [kind, key, start_ms])).toEqual([["note", UUID_1, at("2026-10-26T17:00:00Z")], ["note", UUID_2, at("2026-10-26T17:00:00Z")]]);
    const meeting = home.heads(SOURCE)[0]!.content;
    expect(meeting).toEqual({
      type: "granola.mcp-note",
      meeting: {
        id: UUID_1, title: "Synthetic sync & review", date: "Oct 26, 2026 10:30 PM GMT+5:30", meeting_at: "2026-10-26T22:30:00.000+05:30", created_at: "2026-10-26T17:00:00.000Z",
        updated_at: "2026-10-26T18:00:00.000Z", captured_by_me: "true", listed_as_participant: "true", is_workspace_visible: "false", url: `https://notes.granola.ai/d/${UUID_1}`,
      },
      known_participants: { text: `Person A (note creator) (${ACCOUNT}), Person B (person-b@example.com)` },
      private_notes: { text: "Synthetic private note" },
      summary: { text: "### Synthetic summary\n- a point <5 min" },
    });
    expect(JSON.stringify(home.heads(SOURCE))).not.toMatch(/Answer only|Upgrade/u);
    expect((home.heads(SOURCE)[1]!.content as { private_notes: unknown }).private_notes).toEqual({ status: "empty" });

    await home.land(granola, deliver(home, SOURCE, apiPull([{ note: TRANSCRIBED }]), {}, STATED + 60_000));
    expect(home.heads(SOURCE, ["note"]).map((head) => [head.key, (head.content as { type: string }).type])).toEqual([[UUID_1, "granola.note"], [UUID_2, "granola.mcp-note"]]);
    artifact(home.dir, "routes.json", home.heads(SOURCE));
  });

  it("a meeting whose format moved or a note that does not read costs more than itself, or another account's pull or an unnamed file lands anything", async () => {
    const home = openTestHome();
    const moved = mcpPull([{ tool: "get_meetings", text: meetingsText([meetingElement(UUID_1, { moved: true }), meetingElement(UUID_2), `<meeting id="${UUID_3}" title="unclosed>`]) }]);
    const landed = await home.land(granola, deliver(home, SOURCE, moved, {}, STATED));
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual([UUID_2]);
    expect(landed.refusals.map((refusal) => [refusal.key, refusal.violations.join("; ")])).toEqual([
      ["answer-00001.json[0]", `answer-00001.json: meeting ${UUID_1} states no meeting_at`],
      ["answer-00001.json[2]", "answer-00001.json: the meeting's start tag does not read"],
    ]);

    const broken = apiPull([{ note: TRANSCRIBED }, { note: apiNote("not_00000000000009", "99999999-aaaa-4bbb-8ccc-000000000009", { created_at: "yesterday" }) }, { note: SCHEDULED }]);
    const second = await home.land(granola, deliver(home, SOURCE, broken, {}, STATED + 60_000));
    expect(second.refusals.map((refusal) => refusal.key)).toEqual(["notes/not_00000000000009.json"]);
    expect(home.heads(SOURCE, ["note"]).map((head) => head.key)).toEqual([UUID_1, UUID_2]);

    await expect(collect(granola.read(deliver(home, SOURCE, apiPull([{ note: BARE }], "person-b@example.com"), {}, STATED), home.blobs))).rejects.toThrow(/states account "person-b@example\.com"/u);
    await expect(collect(granola.read(deliver(home, SOURCE, { ...apiPull([{ note: BARE }]), "stray.json": Buffer.from("{}") }, {}, STATED), home.blobs))).rejects.toThrow(/stray\.json is in the delivery but not in pull\.json/u);
    artifact(home.dir, "refusals.json", { moved: landed.refusals, broken: second.refusals });
  });

  it("a page that found no meeting is refused, or a delivery with files but no manifest is read", async () => {
    const home = openTestHome();
    const empty = await home.land(granola, deliver(home, SOURCE, {}, { history: true, left: 0, start_ms: null }, STATED));
    expect([empty.refusals, home.heads(SOURCE)]).toEqual([[], []]);
    const { [PULL_MANIFEST]: _manifest, ...unlisted } = apiPull([{ note: BARE }]);
    await expect(collect(granola.read(deliver(home, SOURCE, unlisted, {}, STATED), home.blobs))).rejects.toThrow(/a Granola pull holds pull\.json/u);
  });
});
