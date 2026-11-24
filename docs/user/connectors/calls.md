# Calls

The Calls connector brings your Mac's call history into Lifestream: your phone calls and your
FaceTime calls. Your Mac reads the call history every 5 minutes.

## What it brings in

- Every call in the Mac's call history: phone calls from your iPhone, and FaceTime audio and
  video calls.
- For each call: the number or address of the other person, the name the call history shows for
  them, whether you called or they did, whether it was answered, when it started and how long it
  lasted.

Your calls from the last 7 days come in first. Older calls follow, newest first.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.
- Your iPhone's calls shared with your Mac. Under **To connect**, Calls' window says: "On your
  iPhone, turn on Calls on Other Devices, so your phone calls reach the Mac."

## Add Calls

Calls needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac Sources**
when you set up Lifestream, and kept Calls ticked there, it is already connected. Otherwise:

1. Open **Connectors**, then **Calls**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

Calls is then connected, and your calls start to arrive.

## Where it shows up

- **Timeline** shows each call at its time: the kind of call, such as "Phone call" or "FaceTime
  video call", who it was with, "You called" or "They called", and how long it lasted, such as
  "3 min". A call nobody answered says "Missed" or "No answer".
- **People** gives each caller their name on Timeline, when People knows their number or
  address. Otherwise Timeline shows the name from the call history, or the number.
- **Search** finds a call by the name or the number of the other person.
- **Chat** reads your calls when a question needs them.

## What a model reads

No AI model reads Calls, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Calls has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new calls **Every 5 minutes**, and brings in your past from Lifestream's start. It has no
**Catch up every**: your Mac sends your past at its own speed.

## Limits

- Lifestream reads only the Mac's call history. Calls in other apps, such as WhatsApp, are not in
  it. [WhatsApp](./whatsapp.md) brings in its own calls.
- macOS removes the oldest calls from the call history. A call that macOS removed before
  Lifestream read it cannot come in.
- A call you delete from the call history stays in Lifestream and on Timeline.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Calls as you would any connector.
Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops Calls too,
with every other connector that needs it.
