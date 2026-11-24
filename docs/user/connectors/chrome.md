# Chrome

The Chrome connector brings your browsing history from Google Chrome on your Mac into Lifestream: the
pages you visit, what you search, and what you download. Lifestream reads Chrome's history on your
Mac every 5 minutes, and brings in your past, newest first.

This connector is not the Chrome extension. The extension lets Lifestream read sites in your browser;
see [Add the Chrome extension](../chrome-extension.md).

## What it brings in

- Every page you visit, with its title and address.
- Every search that Chrome keeps in its history, with its words.
- Every file you download, with its name and where it came from.
- Visits that Chrome syncs to your Mac from your other devices.

Lifestream reads every Chrome profile on your Mac that has a history. Each profile comes in on its
own.

Visits from the last 7 days come in first. Older visits follow, newest first. Chrome itself deletes
visits after about 90 days, so your past goes back about that far.

## Before you start

- Lifestream on your Mac.
- Google Chrome on the same Mac.

## Add Chrome

Chrome needs no permission. If Google Chrome is on your Mac, Chrome is already connected
on **Connectors**.

If Chrome is not on your Mac, Chrome's window says **Install Google Chrome on** *your Mac's
name*. Install Chrome, and the connector connects.

## Where it shows up

- **Timeline** shows the sites you visited, with how many times and the titles of the pages. A
  visit you made while you sat at your Mac stands inside that time at your Mac. A search shows
  its words, and a download its file name.
- **Search** finds a page by its title or its address, and a search by its words.
- **Chat** reads your browsing history when a question needs it.

Pages that the Chrome extension opens for Lifestream are not pages you looked at. Timeline and
Search leave them out.

## What a model reads

No AI model reads Chrome, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Chrome has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new visits **Every 5 minutes**, and brings in your past from Lifestream's start.

If you have more than one Chrome profile, each is a row under **Comes from**, such as **Default**
and **Profile 2**, with its own switch. Turn a row off to stop reading that profile.

## Limits

- Lifestream reads Chrome only on your Mac. A visit on your iPhone or another computer comes in
  only when Chrome syncs it to your Mac.
- If you delete history in Chrome, Lifestream keeps the visits it already brought in.
