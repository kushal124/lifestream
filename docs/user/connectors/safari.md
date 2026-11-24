# Safari

The Safari connector brings your Safari history from your Mac into Lifestream: the pages you visit,
and the tabs open on your other devices. Lifestream reads Safari's history on your Mac every 5
minutes, and brings in your past, newest first.

## What it brings in

- Every page you visit in Safari on your Mac, with its title and address.
- The visits Safari syncs to your Mac from your other devices.
- The tabs open in Safari on those devices, with the name of each device.
- What you clear from Safari's history, so that Lifestream can clear it too.

Visits from the last 7 days come in first. Older visits follow, newest first, back to the oldest
visit Safari holds.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.

## Add Safari

Safari needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac Sources**
when you set up Lifestream, and kept Safari ticked there, it is already connected. Otherwise:

1. Open **Connectors**, then **Safari**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

Safari is then connected, and your visits start to arrive.

## Where it shows up

- **Timeline** shows the sites you visited, with how many times and the titles of the pages. A
  visit you made while you sat at your Mac stands inside that time at your Mac. A tab open on
  another device shows with that device's name.
- **Search** finds a page by its title or its address.
- **Chat** reads your browsing history when a question needs it.

## What a model reads

No AI model reads Safari, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Safari has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new visits **Every 5 minutes**, and brings in your past from Lifestream's start.

## Limits

- Lifestream reads only Safari's default profile. Visits in another Safari profile do not come in.
- If you clear history in Safari, Lifestream removes the visits you cleared from Timeline and
  Search. If Safari keeps the cleared address encrypted, Lifestream cannot tell which visits it
  was, and they stay.
- A visit that Safari deletes because it is old stays in Lifestream.
- Lifestream cannot tell which device a synced visit came from. Timeline says only that it came
  from another device.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Safari as you would any
connector. Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops
Safari too, with every other connector that needs it.
