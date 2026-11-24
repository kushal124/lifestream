# Google activity

The Google activity connector brings in what you searched, watched and looked up across Google, as
Google's My Activity records it. It comes only from a Google Takeout, Google's export of your
data, which you ask Google for and hand to Lifestream on your Mac.

## What it brings in

- Your Google searches, including image and video searches, AI Mode and Google Lens.
- The YouTube videos you watched, and the channels you subscribed to and the videos you liked.
- Your Google Maps directions, and the places and areas you looked at.
- What you asked Gemini.
- Your activity in most other Google products, such as Chrome, Android, Google Play and Gmail.
- The images and audio files that Google keeps with an entry.

Each entry keeps its time, its title and its link. It does not bring in your Google Pay activity.

Each Google product is its own row under **Comes from** in the connector's window, such as **Google
Search**, **YouTube** and **Google Maps**.

The Chrome entries here are the activity Google keeps for your account. They are not the
[Chrome connector](./chrome.md), which reads Chrome's history on your Mac.

## Before you start

- Lifestream on your Mac.
- A Google Takeout that includes **My Activity**.

## Add Google activity

Google activity has no step of its own. Open **Connectors**: it stands under
**Imports**, and opens the **Google Takeout** window. Follow
[Bring in your past from an export](../imports.md).

When you ask Google for the Takeout, choose **JSON** for My Activity. Lifestream also reads HTML,
Google's default, but HTML leaves out the places, the details and the files of each entry.

Google activity is connected when the Takeout's My Activity is in.

## Where it shows up

**Chat** reads your Google activity when a question needs it. Timeline and Search do not show it.

## What a model reads

No AI model reads Google activity, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Limits

- Google activity is only as recent as your newest Takeout. To bring in what came after it, ask
  Google for a new Takeout and hand it to Lifestream. An entry Lifestream already holds is not
  brought in twice.
- An entry that a later Takeout no longer holds stays in Lifestream.

## Problems and fixes

Google activity shows no messages of its own. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show). For the ones an import can show, see
[Bring in your past from an export](../imports.md#problems-and-fixes).
