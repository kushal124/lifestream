# Screen Time

The Screen Time connector brings in which app you were in, and when, on your Mac and on your iPhone.
Your Mac reads Apple's own record of the apps you use, which also holds your iPhone's when it
shares Screen Time with your Mac.

## What it brings in

- Each time an app comes to the front, and each time it leaves, on your Mac.
- The same for your iPhone, and any other device that shares Screen Time with your Mac.

Your past comes in with the first read: what Apple's record still holds, from the connector's
start on. Apple deletes the oldest
part of it by itself, after about four weeks.

Your Mac sends Screen Time to Lifestream at most once an hour. Your iPhone's app switches reach your
Mac when Apple syncs them, which can take hours or days.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.
- For your iPhone's apps: on your iPhone, open Settings, then **Screen Time**, and turn on **Share
  Across Devices**.

## Add Screen Time

Screen Time needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac
Sources** when you set up Lifestream, and kept Screen Time ticked there, it is already connected.
Otherwise:

1. Open **Connectors**, then **Screen Time**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

Screen Time is then connected, and your app switches start to arrive.

## Where it shows up

- **Timeline** shows each stretch you used your iPhone as a row named Phone, with the apps you used
  and for how long. A stretch ends after 5 minutes away from the iPhone.
- Your Mac's own app switches stay in Lifestream. Timeline shows your time at your Mac through
  [Screen](./screen.md) instead.

## What a model reads

No AI model reads Screen Time, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Screen Time has the [settings every connector has](./README.md#settings-every-connector-has), but no
**Catch up every**. By default, it checks for new app switches **Every 5 minutes**, and brings in
your past from Lifestream's start. Your Mac still sends at most once an hour.

## Limits

- The iPhone app from TestFlight cannot read Screen Time on your iPhone itself. Its Screen Time
  page says **This build of Lifestream does not include it.** Your iPhone's apps reach Lifestream
  only through your Mac.
- Timeline names each iPhone app by the last part of its app ID, so Safari shows as
  "Mobilesafari".

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Screen Time as you would any
connector. Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops
Screen Time too, with every other connector that needs it.
