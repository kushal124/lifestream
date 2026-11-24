import type { Client } from "@lifestreamprotocol/connect/sdk";

export const google = {
  id: "google",
  name: "Google",
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  params: { access_type: "offline", prompt: "consent" },
  before: [
    "At console.cloud.google.com, make a project for Lifestream.",
    "Under Google Auth Platform, fill in Branding, choose External under Audience, and press Publish app, so your sign-in does not end after seven days.",
    "Under Clients, make a client of type Desktop app, and copy its client ID and client secret here.",
  ],
} as const satisfies Client;
