# Move Lifestream's folder

Move Lifestream's folder to another folder or drive on this Mac, or take it to another Mac. The
Mac app has no control for this: you run a command in Terminal.
[Lifestream's folder and its disk](./your-home.md) says what the folder holds and where it is now.

## Before you start

- A new folder for Lifestream, empty or not there yet. The move makes it.
- A place the folder may live, as
  [Lifestream's folder and its disk](./your-home.md#where-the-folder-lives) lists. The disk must be
  formatted APFS. Disk Utility shows the format, and can change it.
- Room on that disk for the whole folder, and 5 GB more.
- To move it on this Mac, a Lifestream that is not encrypted. The command does not move an
  encrypted Lifestream.

## Move it on this Mac

1. Open Terminal.
2. Run this command, with the new folder at the end in place of `/Volumes/Drive/Lifestream`:

   ```sh
   ~/.local/bin/lifestream move /Volumes/Drive/Lifestream
   ```

3. Wait for the copy to end. Every 10 seconds, the command says how far it is and how long the
   rest takes.

When the copy is done, the command says **Lifestream is at** the new folder, and that the old folder
**stays**. Lifestream stops until then. Your Mac and your iPhone keep what they record meanwhile,
and send it once Lifestream starts again in the new folder.

To check, open **Settings** (⌘,) and click **Storage**. **Folder**, under **Location**, shows the new
folder. The bar is now the new disk's, and **Growth** waits for a week of readings of it before it
says how fast it fills.

The old folder is a full copy until you delete it. Lifestream does not back up your data, so the
old folder is your only second copy. Delete it in the Finder when you no longer want it.

If the command stops before it says **Lifestream is at**, Lifestream stays in the old folder. Run
the command again to copy again. To move it back, run it with the old folder.

## If the command refuses the folder

The command checks everything before it changes anything. If it refuses, Lifestream stays where it
is, and the command says why:

- **is on a** *kind of* **disk; Lifestream needs APFS**: format the disk APFS in Disk Utility, or
  choose another disk.
- **the move needs** an amount: the disk does not have room for the folder and 5 GB more. Free some
  space, or choose another disk.
- **holds files that are not Lifestream's: choose an empty folder**: choose a folder that is empty
  or not there yet.
- **holds an encrypted Lifestream, and lifestream move works only on one that is not encrypted:
  nothing changed**: Lifestream is encrypted, and the command does not move it.

## Move it to another Mac

1. On the old Mac, open Terminal, and stop Lifestream there:

   ```sh
   ~/.local/bin/lifestream retire
   ```

   Lifestream stops, and does not start on the old Mac again.
2. Copy the whole of Lifestream's folder to the new Mac. If the folder is on an external drive,
   plug the drive into the new Mac instead.
3. On the new Mac, install Lifestream as the [quick start](./quick-start.md) says.
4. At **Where should Lifestream keep your data?**, choose the copied folder: click **Change** under
   **This Mac**, or **Choose** under **An external drive**. Then click **Set up**. Setup refuses a
   folder on a disk that is not APFS, as the command does.
5. Type your recovery key when Lifestream asks for it, and click **Unlock**. Until you do, the menu
   bar menu says **Lifestream is locked** if Lifestream is encrypted, and nothing in it opens.
   Otherwise it says **Passwords are locked on this Mac**, and only your vault stays locked. The
   window names the key that opens it, such as **recovery key 2, made on 17 November 2026**, so you
   know which file to look for.
6. [Pair your iPhone](./pair-your-iphone.md) with the new Mac. Your iPhone knows only the old Mac's
   address.
7. [Add the Chrome extension](./chrome-extension.md) and [connect your agents](./connect-an-agent.md)
   again on the new Mac.

When Timeline on the new Mac shows your days, [uninstall Lifestream](./uninstall.md) from the old
Mac.

## Next

- [Lifestream's folder and its disk](./your-home.md)
- [Pair your iPhone](./pair-your-iphone.md)
