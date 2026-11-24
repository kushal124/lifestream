# Keyboard and mouse

The Keyboard and mouse connector records the keys you press and the clicks you make on your Mac, and
which app each one went to. The Mac app records it while it records your screen, and sends it to
Lifestream. Its use is to help [Screen](./screen.md) say what you did at your Mac.

## What it brings in

- Each key you press, with the character it typed, or its name for a key such as Return or Tab.
- Each click, with the mouse button, where it was on the screen, and what you clicked, such as a
  link or a field: its label, and up to 256 characters of its text.
- Your scrolls, and where the pointer moved, at most 10 times a second.
- Each time an app comes to the front.
- The field your keys went into, with its label.
- When your screen locks, and when another app keeps keys from Lifestream, such as a password
  prompt.

Keyboard and mouse never records what you type into a password field. It keeps only that a key was
pressed, and when, never which key, and it drops Shift and the other modifier keys too, so the
capitals cannot be guessed. It records nothing while your screen is locked. It never records the
clipboard, trackpad gestures, or the text that an input method composes, such as for Chinese or
Japanese.

The **Apps and sites** setting on Screen's window applies to Keyboard and mouse too. An app or site
at **Never** leaves nothing, not even a count. An app or site at **Activity only** leaves a count of
its keys and clicks, and when it came to the front.

Keyboard and mouse has no past to bring in. The Mac app keeps its own copy for 30 days after
Lifestream has it.

## Before you start

- Lifestream on your Mac, allowed to use Accessibility. The steps below allow it.

## Add Keyboard and mouse

During setup, on **Record what you do on this Mac**, click **Allow** beside **Keyboard and
mouse**. To add it later:

1. Open **Connectors**, then **Keyboard and mouse**.
2. Beside **Allow Accessibility on** *your Mac's name*, click **Allow**. System Settings
   opens.
3. Find **Lifestream** in the list, and turn its switch on.

Lifestream starts to record your keys and clicks within a few seconds. It does not need to quit
and reopen.

## Where it shows up

Keyboard and mouse has no rows of its own on Timeline. Screen reads it to write what you did in each
sitting: see [Where it shows up](./screen.md#where-it-shows-up) on the Screen page.

## What a model reads

Keyboard and mouse has no **AI** section of its own. **Screen summaries** sends what you typed and
clicked to a model, with the rest of each sitting, but never the keys of a password field. The
Screen page says [what that model reads](./screen.md#what-a-model-reads), and which models may
read it.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Keyboard and mouse has none of the [settings every connector
has](./README.md#settings-every-connector-has), and none of its own. **Apps and sites** on Screen's
window says which apps and sites it records.

**Disconnect** stops your Mac recording keys and clicks. **Pause recording** in the menu bar menu
stops Keyboard and mouse with the rest of recording.

## Problems and fixes

These are the messages only Keyboard and mouse shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**keys and clicks not recorded**\
The menu bar menu's recording line ends with this when Lifestream may not use Accessibility.
Keyboard and mouse then records only which app comes to the front. Follow [Add Keyboard and
mouse](#add-keyboard-and-mouse).
