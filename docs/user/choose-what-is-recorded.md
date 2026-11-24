# Choose what is recorded

Choose what Lifestream records on your Mac and your iPhone. You can pause all recording on your
Mac for a while, keep an app or a site out for good, or stop one connector.

## Pause all recording on your Mac

1. Click Lifestream's icon in your Mac's menu bar.
2. Click **Pause recording**.

The menu then says **Recording paused**. Your Mac stops recording your screen, your keys and
clicks, audio and its own events, such as sleep and wake. To record again, click **Start
recording**. The window's **Recording** menu has the same two commands.

A pause lasts until you start recording again. It stays when Lifestream quits and opens again,
such as after your Mac restarts or Lifestream updates.

## Keep an app or a site out

1. Open **Connectors**, then **Screen**.
2. Under **Settings**, click **Apps and sites**.
3. Type the name of an app, or a site such as `mybank.example`, and click it in the list. It is
   added at **Never**.
4. To keep only some of it, click its setting and choose **Activity only**.

**Never** keeps nothing. **Activity only** keeps the app and the time, never the screen.
**Record** keeps everything. A site also covers its subdomains, such as `www.mybank.example`.
While any site is on the list, Screen does not record a browser page whose site it cannot read.

The list applies to [Screen](./connectors/screen.md#settings),
[Keyboard and mouse](./connectors/input.md), [Audio](./connectors/audio.md) and
[Mac events](./connectors/machine.md). Each page says what that connector keeps of an app at
**Activity only**.

During setup, **Edit** beside **Never recorded**, on **Record what you do on this Mac**, adds
apps and sites at **Never** to the same list.

## Private windows and password fields

Lifestream never records a password field, on screen or from your keys. Password managers
(Keychain Access, Passwords, 1Password, Bitwarden, LastPass, Dashlane, KeePassXC and Proton Pass)
are at **Never** from the start. The note under **Apps and sites** says whether your Mac also keeps
private browser windows out. It does so only when your Mac's first language is English
and Lifestream can tell a private window apart in every browser on your Mac.

## Pause or disconnect one connector

[Pause or disconnect a connector](./connectors/README.md#pause-or-disconnect-a-connector) says how.
For Screen, Keyboard and mouse, or Audio, **Pause reading** lets your Mac go on recording, and
**Disconnect** stops it.

## Stop your iPhone recording

Your iPhone has no pause for all recording. It records each connector you allowed, until you take
that permission back.

1. In Lifestream on your iPhone, tap the Connectors button at the top of any tab, then tap the
   connector.
2. Tap **Disconnect**. Lifestream asks **Disconnect Location?**, or the name of your connector.
3. Tap **Open Settings**, and turn off the permission in iOS Settings.

To keep the permission and stop only Lifestream reading the connector, tap **Pause** instead of
**Disconnect**. To stop your iPhone sending to Lifestream without stopping it recording,
[unpair it](./pair-your-iphone.md#unpair-or-remove-an-iphone).

## Next

- [Screen](./connectors/screen.md), for everything the Screen connector records and keeps.
- [Connectors](./connectors/README.md), to pause a connector or change its settings.
