# Update Lifestream

Lifestream updates the Mac app by itself, TestFlight updates the iPhone app, and Chrome updates the
extension. This guide says when each update installs, how to install one now, and what to do when a
device and Lifestream are on different versions.

## The Mac app

The Mac app checks for an update every hour and downloads it in the background. While your Mac is
on a phone's hotspot, or on a network with Low Data Mode on, the hourly check waits. An update of
the Mac app also updates Lifestream, which runs the version the Mac app carries.

With **Install updates automatically** on, Lifestream restarts into the update the next time you
lock your screen. Your Mac records nothing while it is locked, so the restart loses nothing. If
your Mac does not lock for a day, Lifestream asks you to restart instead.

To install a downloaded update now:

1. In the Lifestream window, click your name at the foot of the sidebar. A dot beside it shows that
   an update waits, and its menu says **Lifestream** *version* **is ready**.
2. Click **Restart to Update**.

The same line, with **Restart to Update**, also shows on **Connectors**, in the menu bar menu and as a
notification. Quitting Lifestream or logging out installs the update too. After the restart, the
menu bar menu shows **What's new in** *version* for a day.

An encrypted Lifestream opens after an update with this Mac's key, as after any restart. You type
no recovery key, and macOS asks for no password.

### Change how the Mac app updates

1. Open **Settings** (⌘,) and click **Updates**.
2. **Version** shows the version you run. Click **Check for Updates…** to look
   for a new one now, on any network.
3. To choose when updates install, turn off **Install updates automatically**. Each update then
   waits for you to click **Restart to Update**.

## The iPhone app

TestFlight installs each new build of the iPhone app by itself, unless you turned off its automatic
updates. To update by hand, open TestFlight and tap **Update** beside Lifestream.

## The Chrome extension

Chrome updates the extension from the Chrome Web Store, at Chrome's own pace. The extension takes a
new version when it is not reading a site.

If Lifestream needs a newer extension, the extension asks Chrome to look for one. Its window, which
opens from Lifestream's icon in Chrome's toolbar, then says **Update the Lifestream extension**,
with the version it has and the one Lifestream needs. Click **Open** to open Chrome's extensions
page. There, turn on **Developer mode** and click **Update**.

## When a device and Lifestream are on different versions

A device sends to Lifestream only when both are new enough for each other. While one waits, it
keeps what it records and sends it after the update. Nothing is lost.

| You see | What it means and what to do |
|---|---|
| **Lifestream needs an update** · **Update it on your Mac** | Lifestream on your Mac is older than the device that shows this. Your iPhone shows it at the top of each tab, and your Mac in its menu bar menu and at the top of the Lifestream window. Update the Mac app: click **Check for Updates…** in **Settings** › **Updates**, then **Restart to Update**. |
| **Update Lifestream on this iPhone** · **What it records waits here** | The iPhone app is older than Lifestream. Update it in TestFlight. While you pair, your iPhone says the same in other words: **Your Mac needs a newer Lifestream on this iPhone. Update the app, then pair.** |
| **Lifestream on your Mac needs its update before Chrome can send to it.** | The extension shows this under **Waiting for Lifestream**. Update the Mac app. |
| **Update the Lifestream extension:** **this is** *version*, **Lifestream needs** *version* **or later** | Update the extension, as [The Chrome extension](#the-chrome-extension) says. |
| **Lifestream didn't update** · **It runs the release it has meanwhile** | The menu bar menu shows this when an update could not install. Lifestream keeps running the version it has, and the line says why. If it shows **Try again**, fix what it names and click it. |

## Next

- [Pair your iPhone](./pair-your-iphone.md)
- [Uninstall Lifestream](./uninstall.md)
