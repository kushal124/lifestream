import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const spotify = {
  id: "spotify", product: "spotify", name: "Spotify", vendor: "spotify", type: "listening", noun: ["play", "plays"],
  records: "Every play since your account began, with how long it played.",
  sources: [{ id: "spotify:<account>:export", read: "spotify-export", arrives: "upload" }],
  export: {
    recognise: ["**/Streaming_History_*.json"],
    takes: "Spotify takes up to 30 days",
    wait: "Up to 30 days",
    guide: [
      {
        title: "Ask Spotify", words: "On Spotify’s Privacy page, tick Extended streaming history, then press Request data.",
        open: { label: "Open Spotify’s Privacy page", url: "https://www.spotify.com/account/privacy/" },
      },
      { title: "Wait for the email", words: "When Spotify emails you, download the zip." },
    ],
    leaves: ["**/ReadMeFirst_*.pdf"],
  },
} satisfies Connector;
