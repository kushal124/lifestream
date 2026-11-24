# Google Photos

The Google Photos connector brings the photos and videos in your Google Photos into Lifestream. They
come only from a Google Takeout, the export of your data that you ask Google for.

## What it brings in

- Every photo and video in the Takeout, with the details Google keeps beside each one, such as
  when and where you took it.
- Each edited copy Google made, as a photo of its own beside the original.
- The video of a Live Photo or a motion photo, as part of its photo.

It does not keep your albums. A photo that is in two albums comes in once. A photo you delete in
Google Photos later stays in Lifestream: a newer Takeout adds photos, and never removes one.

If you also bring in [Photos](./photos.md), Lifestream shows a photo that is in both only once.
It takes two photos as one when they are the same file, or have the same file name and were taken
within 1 second of each other. The Photos connector then decides that photo's time and its
description. Until Lifestream has your Apple copy's file, it shows Google's. When your Takeout
holds a photo's file, or a Live Photo's video, at the same name and size as your Apple copy,
your Mac and your iPhone do not send that file again.

## Before you start

- Lifestream on your Mac.
- A Google Takeout with **Google Photos** ticked. [Bring in your past from an export](../imports.md)
  says how to ask Google for it and hand it to Lifestream.

## Add Google Photos

Google Photos stands under **Imports** on **Connectors**, with the line **Comes with
a Google Takeout**. Clicking it opens the **Google Takeout** window. Once Lifestream has your
Takeout's files, Google Photos is then connected.

## Where it shows up

Your Google photos show up in the same places as your Apple photos: Timeline, Search, Places,
People and Chat. [Photos](./photos.md#where-it-shows-up) says how. They open full size as your
Apple photos do, and videos and Live Photos play:
[Look at a photo or a video](./photos.md#look-at-a-photo-or-a-video) says how.

## What a model reads

A model writes **Photo descriptions** of your Google photos, so you can search them by what is in
them.

- **Sends**, **Never sends** and **Hidden first:** as for [Photos](./photos.md#what-a-model-reads).
- **By default:** the **Default** model, for photos from 30 days before you brought in your Takeout.
  Older photos get no description. To describe them all, set **Read back to** under **AI** to **All
  time**.
- **To stop it:** set **Photo descriptions** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Of the [settings every connector has](./README.md#settings-every-connector-has), Google Photos has
only **AI**. It has no **Check every** and no **History**: each Takeout brings in everything it
holds.

## Limits

- Lifestream reads a photo together with the details file Google puts beside it. A large Takeout
  comes as several files, and a photo can be in one file and its details in another. The photo
  waits until you hand over that file too.
- A photo whose details give no time is not brought in.
