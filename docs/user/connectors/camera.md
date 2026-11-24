# Camera

The Camera connector brings in the photos you take with the camera in the iPhone app. Your iPhone
sends each photo to Lifestream.

## What it brings in

- Each photo you take with the iPhone app's camera, exactly as the camera made it.
- When you took it, and the last place Location recorded, if Location is on.

These photos stay in the iPhone app. They do not go into your Photos library, so the
[Photos](./photos.md) connector never brings them in.

## Before you start

- Lifestream on your iPhone, [paired](../pair-your-iphone.md) with your Mac.

## Add Camera

Camera is ready once your iPhone is paired. To take a photo:

1. In the iPhone app, open **Timeline** and tap **+** at the top.
2. Tap **Photo**. The camera opens.
3. The first time, iOS asks to let Lifestream use the camera. Allow it.
4. Tap the shutter button.

On your iPhone, Camera is under **This iPhone** on **Connectors**. On your Mac, Camera is on
**Connectors** too, with your iPhone's icon after its name.

## Where it shows up

Your Camera photos show up in the same places as the photos in your library: Timeline, Search,
Places, People and Chat. [Photos](./photos.md#where-it-shows-up) says how.

## What a model reads

A model writes **Photo descriptions** of your Camera photos, so you can search them by what is in
them.

- **Sends**, **Never sends** and **Hidden first:** as for [Photos](./photos.md#what-a-model-reads).
- **By default:** the **Default** model.
- **To stop it:** set **Photo descriptions** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Of the [settings every connector has](./README.md#settings-every-connector-has), Camera has only
**AI**.

## Problems and fixes

This is the message only Camera shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Camera access is off. Allow it in Settings to take photos here.**\
The camera shows this when you did not allow the camera for Lifestream. Tap **Open Settings** and
turn on **Camera**.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Camera as you would any
connector. To also take back the camera, turn off **Camera** for Lifestream in iOS Settings.
