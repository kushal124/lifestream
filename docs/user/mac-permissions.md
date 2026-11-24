# What the Mac asks to allow

Lifestream asks macOS for seven permissions, each for the connectors that need it, and only when
you click **Allow**. This page says why it asks for each one, which connectors use it, and what
happens if you do not allow it.

## The permissions

| Permission | What it lets Lifestream keep | Connectors that use it | Without it |
|---|---|---|---|
| Screen Recording | What is on your screen, every 2 seconds. | [Screen](./connectors/screen.md) | Screen records nothing. |
| Accessibility | Which window and page is in front, its text, and your keys and clicks, but never what you type in a password field. | [Keyboard and mouse](./connectors/input.md), and [Screen](./connectors/screen.md) for the text of the window in front | Keyboard and mouse records only which app comes to the front. Screen reads text only from its picture of the screen. |
| Microphone | The microphone, while another app is using it. | [Audio](./connectors/audio.md) | Audio does not record your side of a call. |
| System Audio Recording | What your Mac plays while the microphone is in use: the other side of a call. | [Audio](./connectors/audio.md) | Audio records only your side of a call. |
| Bluetooth | When Bluetooth devices connect and disconnect. | [Mac events](./connectors/machine.md) | Mac events leaves out Bluetooth devices. Lifestream marks it **Optional**. |
| Full Disk Access | Your messages, notes, calls and other apps' history on this Mac. | [iMessage](./connectors/imessage.md), [WhatsApp](./connectors/whatsapp.md), [Notes](./connectors/notes.md), [Calendar](./connectors/calendar.md), [Reminders](./connectors/reminders.md), [Calls](./connectors/calls.md), [Safari](./connectors/safari.md), [Screen Time](./connectors/screen-time.md), [Now playing](./connectors/now-playing.md) | These connectors bring in nothing from this Mac. |
| Photos | Every photo and video in Photos on this Mac. | [Photos](./connectors/photos.md) | Photos brings in nothing from this Mac. |

A connector that waits for a permission says so on **Connectors**, such as **Full Disk Access needs
access**. [Connectors](./connectors/README.md#messages-every-connector-can-show) says what to do.

Other connectors on your Mac, such as [Chrome](./connectors/chrome.md), [Claude Code](./connectors/claude-code.md)
and [Wispr Flow](./connectors/wispr-flow.md), need no permission.

## See and allow them

Open **Settings** (⌘,) and click **This Mac**. **Permissions** lists all seven, each with
**Allowed** or an **Allow** button. If more than one is missing, **Allow all** asks for each of
them. The menu bar menu says how many are missing, such as **Allow 2 permissions…**. Both leave
out Bluetooth, which is optional.

Click **Allow**, and System Settings opens at the permission's list. Turn Lifestream on. For Screen
Recording, macOS then asks you to quit Lifestream: choose **Quit & Reopen**. No other permission
needs Lifestream to restart.

To take a permission back, turn Lifestream off in the same list in System Settings, under
**Privacy & Security**. Screen Recording and System Audio Recording share one list.

## Three more things macOS asks

- **Notifications**: macOS asks the first time Lifestream has something to tell you, such as
  **Can't reach Lifestream**.
- **Your login password, for the Keychain**: Lifestream keeps its keys in your Mac's Keychain. It
  reads the keys it made with no question. When you click **Allow** on a key Lifestream cannot
  read by itself, such as after you set Lifestream up again, macOS asks for your login password:
  type it and choose **Always Allow**, or it asks again next time.
  [How Lifestream keeps your data safe](./keep-your-data-safe.md#where-the-keys-are) says what
  the keys open.
- **Open at login** lets Lifestream open when you log in, so your Mac records after a restart.
  Setup asks for it once. To change it, open **Settings** › **This Mac** › **Open at login**.

Lifestream never asks for Input Monitoring. Once you allow Accessibility, macOS lets Lifestream hear
your keys, and can list Lifestream under Input Monitoring by itself.

## Next

- [Connectors](./connectors/README.md), to add a connector or pause one.
- [Choose what is recorded](./choose-what-is-recorded.md), to keep apps and sites out of what your Mac records.
- [How Lifestream keeps your data safe](./keep-your-data-safe.md)
