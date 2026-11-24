import { archive, basicInstant, consuming, digest, each, instantOf, isObject, jsonElements, readJson, refuse, utf8, wholeFiles, type ImportStated, type Json, type JsonObject, type Member, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const SPOTIFY_CONNECTOR = "spotify-export";
const HISTORY = /(?:^|\/)Streaming_History_(Audio|Video)_[^/]*\.json$/u;
const USERDATA = /(?:^|\/)Userdata\.json$/u;
const README = /(?:^|\/)ReadMeFirst_[^/]*\.pdf$/iu;
const ITEMS = ["spotify_track_uri", "spotify_episode_uri", "audiobook_chapter_uri"] as const;

export interface SpotifyMember {
  name: string;
  where: string;
  chunks(): AsyncIterable<Buffer>;
  bytes(): Buffer;
}

export const spotifyConnector: Reader = {
  name: SPOTIFY_CONNECTOR,
  kinds: { play: playGuard },
  account: { file: "**/Userdata.json", json: (stated) => (isObject(stated) && typeof stated.username === "string" ? stated.username : undefined) },
  states: spotifyStated,
  async *read(delivery, files) {
    const account = spotifyAccount(delivery.source);
    let whole: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, async function* (listed) {
      const members = listed.map(spotifyMember);
      checkAccount(members, account);
      const shared = await sharedKeys(members);
      for await (const row of spotifyRows(members)) {
        const rank = row.refused === undefined ? shared.get(row.key)?.indexOf(digest(row.content!)) ?? 0 : 0;
        yield rank === 0 ? row : { ...row, key: `${row.key}:${rank}` };
      }
      whole = wholeFiles(listed, (member) => HISTORY.test(member.name) || USERDATA.test(member.name) || README.test(member.name));
    }), () => whole);
  },
};

function spotifyMember(member: Member): SpotifyMember {
  return { name: member.name, where: member.zip === undefined ? member.where : `${member.zip}:${member.name}`, chunks: () => member.chunks(), bytes: () => member.bytes() };
}

export function spotifyAccount(source: string): string {
  return /^spotify:([^:\s]+):export$/u.exec(source)?.[1] ?? refuse(`${source} is not a spotify:<user>:export source`);
}

export function checkAccount(members: readonly SpotifyMember[], account: string): void {
  for (const member of members) {
    if (!USERDATA.test(member.name)) continue;
    const stated = readJson(utf8(member.bytes(), member.where), member.where);
    const user = isObject(stated) ? stated.username : undefined;
    if (user !== account) refuse(`${member.where} states user ${JSON.stringify(user ?? null)}; the source is spotify:${account}:export`);
  }
}

async function spotifyStated(listed: readonly Member[], anchor: string | null): Promise<ImportStated> {
  let newest = 0;
  let earliest: { key: string; ms: number } | undefined;
  let restated = false;
  for await (const play of spotifyRows(listed.map(spotifyMember))) {
    if (play.refused !== undefined) continue;
    const ms = play.time!.start_ms;
    newest = Math.max(newest, ms);
    if (earliest === undefined || ms < earliest.ms || (ms === earliest.ms && play.key < earliest.key)) earliest = { key: play.key, ms };
    restated ||= play.key === anchor;
  }
  if (earliest === undefined) refuse("This Spotify export lists no play.");
  if (anchor !== null && !restated) refuse("This isn't the same account's history as your earlier Spotify export: it doesn't hold the plays that one began with.");
  return { time_ms: newest, anchor: anchor ?? earliest.key };
}

export function spotifyRows(members: readonly SpotifyMember[]): AsyncGenerator<ReaderOutput> {
  const history = members.filter((member) => HISTORY.test(member.name)).sort((left, right) => (left.where < right.where ? -1 : 1));
  if (history.length === 0) refuse("the export holds no Streaming_History_Audio_… or Streaming_History_Video_… member");
  return each(history, (member) => member.where, (member) => {
    const kind = HISTORY.exec(member.name)![1]!.toLowerCase();
    return each(jsonElements(member.chunks(), member.where), (element) => element.where, ({ read, where: at }) => {
      const value = readJson(utf8(read(), at), at);
      if (!isObject(value)) refuse(`${at}: a play must be an object`);
      return [play(value, kind, at)];
    });
  });
}

function play(value: JsonObject, history: string, at: string): ReaderOutput {
  if (typeof value.ts !== "string") refuse(`${at}.ts must be the play's end, a full RFC 3339 instant`);
  const end = instantOf(value.ts, "rfc3339", `${at}.ts`);
  const items = ITEMS.filter((name) => value[name] !== undefined && value[name] !== null);
  if (items.length !== 1) refuse(`${at} names ${items.length === 0 ? "no" : items.length} items; a play is of one track, episode or audiobook chapter`);
  const uri = value[items[0]!];
  if (typeof uri !== "string" || !/^spotify:\S+$/u.test(uri)) refuse(`${at}.${items[0]!} must be a Spotify URI`);
  return { kind: "play", key: `${basicInstant(end.start_ms)}:${uri}`, content: { type: "spotify.play", history, play: value }, time: end, locator: at };
}

async function sharedKeys(members: readonly SpotifyMember[]): Promise<Map<string, string[]>> {
  const seen = new Map<string, string | string[]>();
  for await (const row of spotifyRows(members)) {
    if (row.refused !== undefined) continue;
    const played = digest(row.content!);
    const held = seen.get(row.key);
    if (held === undefined) seen.set(row.key, played);
    else if (typeof held === "string") {
      if (held !== played) seen.set(row.key, [held, played]);
    } else if (!held.includes(played)) held.push(played);
  }
  const shared = new Map<string, string[]>();
  for (const [base, held] of seen) if (typeof held !== "string") shared.set(base, held.sort());
  return shared;
}


function playGuard(content: Json): string[] {
  if (!isObject(content)) return ["content is not an object"];
  const names = Object.keys(content).sort().join(", ");
  const violations = names === "history, play, type" ? [] : [`members are ${names}, not history, play, type`];
  if (content.type !== "spotify.play") violations.push("type is not spotify.play");
  if (content.history !== "audio" && content.history !== "video") violations.push("history is neither audio nor video");
  if (!isObject(content.play) || typeof content.play.ts !== "string") violations.push("play is not an object stating ts");
  return violations;
}
