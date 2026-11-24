# Mac events

The Mac events connector records what your Mac itself does: when it sleeps and wakes, locks, changes
power, and which apps use its microphone and camera. The Mac app records it while it records your
screen, and sends it to Lifestream. Its use is to help [Screen](./screen.md) tell when you were at
your Mac.

## What it brings in

From your Mac:

- Sleep and wake, the display's sleep and wake, and lock and unlock.
- When it is plugged in or on battery, with the battery's level, and when its lid opens and
  closes.
- When it joins or leaves Wi-Fi. macOS does not give Lifestream the network's name.
- Which apps use the microphone and which play sound, when a camera is on, and the speaker or
  headphones in use, with the volume.
- Displays you attach and detach, and the light around your Mac when it changes a lot.
- Bluetooth devices that connect and disconnect, with their names, if you allow Bluetooth.
- When recording starts and stops, each time your Mac sends to Lifestream, and each permission your
  Mac gives Lifestream, and when that changes.

From your iPhone, once it is [paired](../pair-your-iphone.md): each permission your iPhone gives
Lifestream, and when that changes.

An app at **Never** in Screen's **Apps and sites** leaves no record of using the microphone or
playing sound. An app at **Activity only** is named, and nothing it said is kept.

Mac events records whenever your Mac records, and has no past to bring in. The Mac app keeps its own
copy, and never deletes it.

## Add Mac events

Mac events needs no step and no permission. It is connected from the start.

To also record Bluetooth devices, open **Connectors** and click your Mac's name. Under
**Permissions**, click **Allow** beside **Bluetooth**, which says **Optional**. Lifestream records
Bluetooth devices from the next time recording starts.

## Where it shows up

Mac events has no rows of its own on Timeline. Screen reads your Mac's events to tell when you were
at your Mac: see [Where it shows up](./screen.md#where-it-shows-up) on the Screen page.

## What a model reads

Mac events has no **AI** section of its own. **Screen summaries** sends a model your
Mac's events during each sitting and for a few minutes around it, with what macOS said
about each one, such as a Bluetooth device's name. It never sends your iPhone's events. The Screen
page says [what that model reads](./screen.md#what-a-model-reads), and which models may read it.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Mac events has none of the [settings every connector has](./README.md#settings-every-connector-has),
and none of its own.

**Disconnect** stops your Mac recording these events. **Pause recording** in the menu bar menu stops
Mac events with the rest of recording.
