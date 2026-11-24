import { isObject, type InputRecord, type Json, type ListeningAdapter, type Play } from "@lifestreamprotocol/connect/sdk";

const SPOTIFY_PLAY = "spotify.play";

export const spotifyListening: ListeningAdapter = {
  version: "1",
  kinds: ["play"],
  play({ version }: InputRecord): Play | null {
    const content = version.content;
    if (!isObject(content) || content.type !== SPOTIFY_PLAY || !isObject(content.play)) return null;
    const play = content.play;
    const item = { app: null, length_s: null };
    const named = typeof play.spotify_track_uri === "string"
      ? { ...item, title: text(play.master_metadata_track_name), artist: text(play.master_metadata_album_artist_name), album: text(play.master_metadata_album_album_name) }
      : typeof play.spotify_episode_uri === "string" ? { ...item, title: text(play.episode_name), artist: text(play.episode_show_name), album: null }
      : typeof play.audiobook_chapter_uri === "string" ? { ...item, title: text(play.audiobook_title), artist: null, album: text(play.audiobook_chapter_title) }
      : null;
    if (named === null) return null;
    return {
      ...named, device: text(play.platform) ?? "", played_ms: typeof play.ms_played === "number" ? play.ms_played : null,
      ...(play.offline === true ? { offline: true as const } : {}),
    };
  },
};

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
