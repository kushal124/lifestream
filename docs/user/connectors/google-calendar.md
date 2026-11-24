# Google Calendar

The Google Calendar connector brings your Google Calendar events into Lifestream. They come in two
ways: Lifestream reads your calendars from Google every 5 minutes, or you hand Lifestream the
calendars in a Google Takeout.

## What it brings in

- Every event in every calendar of the account, the hidden ones too.
- For each event: its title, its time and time zone, its place, its description, its organiser,
  the people invited and their replies, and how it repeats.

When Lifestream reads from Google, it brings in your past first, from the connector's start on. After that, only what
changed comes in, and an event you delete in Google Calendar leaves Timeline.

## Before you start

- Lifestream on your Mac, and your vault unlocked. Lifestream keeps your sign-in in it.
- For Lifestream to read from Google, a Google client of your own: Google gives none to an
  open-source app, so you make one in Google Cloud, once. It is free. A client is what an app
  signs in to Google with; yours is used only by Lifestream.
- For a Google Takeout, nothing more. [Bring in your past from an export](../imports.md) says how
  to ask Google for one.

## Make your Google client

You do this once: Lifestream keeps your client, and any other Google sign-in uses it too. The
sign-in sheet shows these steps as well.

1. At [console.cloud.google.com](https://console.cloud.google.com), make a project for Lifestream.
2. Under **Google Auth Platform**, fill in **Branding** with the app's name and your email, choose
   **External** under **Audience**, and press **Publish app**, so your sign-in does not end after
   seven days. While the app stays in **Testing**, Google ends your sign-in after seven days.
3. Under **Clients**, make a client of type **Desktop app**, and copy its **Client ID** and
   **Client secret**.
4. In the same project, under **APIs & Services**, turn on the **Google Calendar API**.

## Add Google Calendar

1. On **Connectors**, open Google Calendar and press **Sign in with Google**, on your Mac or your
   iPhone.
2. The first time, type your client's **Client ID** and **Client secret**. Lifestream keeps them,
   and does not ask again.
3. Click **Open**. Your browser opens Google. Sign in, and allow Lifestream to see your calendars.
   Google warns that it has not verified the app: it is your own client, so press **Continue**.
4. On your Mac, the page then says **You can close this page**, and Google Calendar is
   connected. If your browser instead ends on a page that does not load, copy that page's whole
   address and paste it in **Paste the address your browser ended on**. If the page said **You can
   close this page** and the sheet shows a red line instead, that line is what went wrong: fix it,
   then press **Start again**. Pasting that address again cannot help, since Google takes a
   sign-in's code once.

Your events then start to arrive.

To use a Google Takeout instead, follow
[Bring in your past from an export](../imports.md). Its calendars come to
Google Calendar by themselves.

## Where it shows up

- **Timeline** shows each event at its time, by its title, with its organiser, how many people
  were invited and your reply. All-day events sit at the top of their day.
- **Search** finds an event by its title, its place, its description, or the address of its
  organiser or anyone invited.
- **People** gives the organiser their name on Timeline, when People knows them.
- **Chat** reads your events when a question needs them.

If you also add [Calendar](./calendar.md), and your Google account is in Calendar on your Mac,
Timeline shows each Google event once, as Google Calendar states it.

## What a model reads

No AI model reads Google Calendar, so its window has no **AI** section. Every word Timeline shows
for an event comes from Google Calendar itself.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Google Calendar has the [settings every connector has](./README.md#settings-every-connector-has).
By default, it checks for new events **Every 5 minutes**, and brings in your past from Lifestream's start.
It has no **Catch up every**.

It has one setting of its own. **Calendars** names the calendars Lifestream reads, each by its
Google calendar ID. When you have added no calendar, the setting shows **Every calendar**, and
Lifestream reads every calendar of the account, with any you make later.

## Limits

- Lifestream reads one Google account from Google.
- A calendar that is shared with you only as free or busy does not come in. Google gives none of
  its events.
- A repeating event shows once, on its first day, with how it repeats. A single time that you
  moved or changed shows on its own day.
- An event set to a floating time, with no time zone, does not show on Timeline.
- From a Google Takeout, only the calendars of the Takeout's own account come in. An event set in
  a time zone before 2007 does not come in either: the Takeout's files give no time-zone rules that
  old.
- A Google Takeout does not say which events you deleted. An event deleted after the Takeout was
  made stays on Timeline until Lifestream reads from Google.

## Problems and fixes

These are the messages only Google Calendar shows, or that mean something of its own here. For
the ones every connector can show, see [Connectors](./README.md#messages-every-connector-can-show).

**Sign in to Google Calendar again**\
Google no longer accepts your sign-in: you took away its access, you made a new client, or your
app is still in **Testing** and seven days passed. Click **Sign in**, and sign in again. If the app
is in **Testing**, publish it first (step 2 of [Make your Google client](#make-your-google-client)).

**Unlock Lifestream on your Mac first**\
Your vault is locked, so Lifestream cannot keep a sign-in. Unlock it on the Mac Lifestream runs on,
then sign in again.
