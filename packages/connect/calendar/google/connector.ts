import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const googleCalendar = {
  id: "google-calendar", product: "google-calendar", name: "Google Calendar", vendor: "google", type: "plans", noun: ["event", "events"], mirror: true,
  gives: "Your Google calendars, with people and place.",
  records: "Every event in your calendars, with people and place.",
  sources: [
    { id: "google-calendar:<account>:cloud", read: "gcal-api", arrives: "poll" },
    { id: "google-calendar:<account>:export", read: "gcal-export", arrives: "upload" },
  ],
  acquirers: ["gcal-api"],
  refresh: { default: "5m", min: "1m" },
  backfill: { about: "Collects the events already in your calendars." },
  fields: {
    account: { kind: "email", label: "Google account", account: true },
    signin: { kind: "secret", label: "Sign-in", secret: "google-calendar.signin" },
    calendars: { kind: "list", label: "Calendars", default: [], empty: "Every calendar" },
  },
  signin: [{
    acquirer: "gcal-api", way: "client", client: "google", field: "signin", label: "Sign in with Google",
    steps: [{
      title: "Turn on the Google Calendar API", words: "In your Google Cloud project, under APIs & Services.",
      open: { label: "Open the Calendar API", url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" },
    }],
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    check: {
      url: "https://www.googleapis.com/calendar/v3/calendars/primary", account: "id",
      forbidden: "Google refused your calendar. Turn on the Google Calendar API in your Cloud project, under APIs & Services, then try again in a minute.",
    },
  }],
  export: { recognise: ["Takeout/Calendar/**/*.ics"], product: { id: "calendar", name: "Calendar" } },
} satisfies Connector;
