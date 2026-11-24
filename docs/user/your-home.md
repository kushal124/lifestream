# Lifestream's folder and its disk

Lifestream keeps everything it gathers about your life in one folder that you choose at setup. This
page says where the folder can live, how fast it grows, and what happens when its disk fills, its
drive is unplugged or your Mac sleeps.

## Where the folder lives

You choose the place once, during setup, on **Where should Lifestream keep your data?**:

- **This Mac** keeps its folder in `~/Lifestream`. Click **Change** to pick another folder on this
  Mac.
- **An external drive** keeps its folder on a drive you pick with **Choose**. The drive must stay
  plugged in.

Lifestream does not let you put its folder in Desktop, Documents or Downloads, in a folder that
iCloud or another cloud service syncs, or on a network drive. Its files need a local disk that
nothing else changes, formatted APFS.

- On a disk of another format, setup says **… is on a … disk; Lifestream needs APFS**. Format the
  disk APFS in Disk Utility, or choose another disk.
- On a disk with less than 5 GB free, setup says **This disk has … free. Choose a folder on a disk
  with more room.**

Setup encrypts the folder, wherever it is: it is unreadable without its key.
[How Lifestream keeps your data safe](./keep-your-data-safe.md) says what that protects.

To see where the folder is now, open **Settings** (⌘,) and click **Storage**. **Folder**, under
**Location**, shows the folder, and the top of the page the free space on its disk.

The Mac app has no control to move the folder after setup. [Move Lifestream's folder](./move-your-home.md)
says how to move it from Terminal.

## How fast it grows

Lifestream plans for your Mac to add about 3 GB a week, and an iPhone about 5 GB a week more,
mostly its photos. Your past comes on top of that while it arrives.

During setup, each choice shows its free space and how long it lasts at that rate, such as **Room
for about 8 months**. If the room on this Mac is under about 3 months, **This Mac** shows **Free up
space**, which opens Storage in macOS's System Settings.

Once Lifestream runs, **Settings** › **Storage** shows what it holds by connector and how it grows: how
much each connector added this week, Lifestream's size by day, and, after a week, how fast its disk
fills and when it is full at that rate. [Settings](./settings.md#storage) says what each part
shows.

## When the disk fills

Every disk Lifestream writes to keeps 5 GB free for what it can never fetch again, such as your
screen and the places you go. Lifestream warns you before the disk gets there, and stops in two
steps after. Nothing already in Lifestream is lost at any step.

1. **The disk fills within a month.** At last week's pace, if the disk will be down to 5 GB free
   within 30 days, Lifestream shows how many days are left, such as **Lifestream's disk fills in
   about 12 days**. If the photos still to come do not fit above those 5 GB, it shows how much more
   room they need instead, such as **Photos need 40 GB more**.
2. **Under 5 GB free.** Lifestream shows **Lifestream's disk is almost full**: "History, photos
   and imports wait for 5 GB free." New data still comes in. Connectors whose past waits show
   [Waiting for disk space on your Mac](./connectors/README.md#messages-every-connector-can-show).
3. **Under 1 GB free.** Lifestream shows **Lifestream's disk is full**: "Nothing new is saved."
   It stands under the bar on every page until there is room. Lifestream stops taking what your Mac
   and iPhone send. They keep what they record, and the menu bar menu says **Lifestream's disk is
   full. What this Mac records waits here until it has room.**

The first two show at the top of **Connectors**. Click **Free up space** to open Storage in System
Settings. When you free space, Lifestream goes on by itself.

The menu bar menu can say **Waiting for space on Lifestream's disk** before step 2. Your Mac then
holds something Lifestream has no room for yet, such as a large file of your past. It sends it
once there is room.

### When your Mac or iPhone fills

Your Mac and your iPhone keep 5 GB free on their own disks too. The message names the device:

- **Under 5 GB free:** *the device's name* **is almost full**. On a Mac, recording goes on, and
  photos and dropped files wait. On an iPhone, older photos wait until it has 5 GB free.
- **Under 1 GB free:** *the device's name* **is full**. On a Mac, recording stops. On an iPhone,
  location and Health are not saved.

If your iPhone has no room to get what it recorded ready to send, it shows **Free** an amount
**on** its name. What it recorded waits on your iPhone until you free that much space.

## When your drive is unplugged

If Lifestream's folder is on an external drive and the drive goes away, Lifestream stops at once.
Your Mac keeps what it records. Within about half a minute, Lifestream tells you:

- A notification says **Can't reach Lifestream**, and why: **Lifestream's drive isn't connected**.
- The menu bar menu says why, and when Lifestream last answered.
- The Lifestream window shows **Can't reach Lifestream** at the top of every page, with the same
  reason. **Details** shows the path to its folder, with the drive the line that broke.

Plug the drive in again. Lifestream starts again by itself within a few seconds, and your Mac sends
what it kept. If the drive shows under another name, eject it and plug it in again.

## When your Mac sleeps

Lifestream runs only while your Mac is awake. Lifestream does not keep your Mac awake, except while
it sends an export to Lifestream. While your Mac sleeps, your connectors bring nothing in, and your
iPhone cannot reach Lifestream. Your iPhone keeps what it records, and sends it once Lifestream
answers again.

## When another program holds the folder open

If another program, such as a database viewer, keeps Lifestream's database open for 10 minutes,
Lifestream shows **Another app holds Lifestream's database open**: "Close it and Lifestream
catches up." Close that program, and Lifestream goes on by itself.

## When Lifestream finds damage

If something reads wrong from the disk, Lifestream stops and checks all its files. The menu bar
menu says **Lifestream is checking its database.** The check can take up to an hour on an external
drive. If the check finds damage, Lifestream says **Lifestream's database is damaged.** It needs a
good copy of its folder put back from your backup, as
[Put a copy back](./back-up.md#put-a-copy-back) says.

## Lifestream does not back up your data

Lifestream keeps one copy of your data, in the folder you chose, and makes no backup of its own.
[Back up Lifestream](./back-up.md) says how to keep one.

## Next

- [Back up Lifestream](./back-up.md), to keep a copy of the folder.
- [Every file and key Lifestream keeps](./what-lifestream-keeps.md), to see every other place it keeps files.
- [Connectors](./connectors/README.md)
- [Uninstall Lifestream](./uninstall.md), to remove Lifestream and keep or erase its folder.
