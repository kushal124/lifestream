# Back up Lifestream

Lifestream keeps one copy of your life, in its folder, and makes no backup of its own. This guide
keeps a backup of that folder with Time Machine, and puts a copy back when Lifestream asks for one.

> [!WARNING]
> Lifestream makes no backup of its own. If its disk fails or its folder is deleted, what your Mac
> and your iPhone recorded, such as your screen and the places you went, is gone. Only some
> connectors, such as Gmail, can bring their data in again from your account.

## Before you start

- A disk for Time Machine, macOS's backup.
- Your recovery key, if Lifestream is encrypted.
  [Keep your recovery key](./recovery-key.md) says how to keep it.

## Back up Lifestream's folder

1. Find Lifestream's folder: open **Settings** (⌘,), click **Storage**, and read **Folder** under
   **Location**.
2. If the folder is on your Mac's own disk, turn on Time Machine in macOS's System Settings. It
   backs up the folder with the rest of your Mac.
3. If the folder is on an external drive, add that drive to Time Machine's backups in macOS's
   System Settings. Time Machine leaves an external drive out until you add it.
4. If Lifestream is not encrypted, encrypt your Time Machine backups.

Time Machine leaves out the copies Lifestream works on while a job runs. They are not needed to put
Lifestream back.

## What a backup holds

A backup of an encrypted Lifestream stays encrypted. It opens only with this Mac's key, or with the
recovery key that was current when the backup was made, so keep that key with the backup.

A backup of a Lifestream that is not encrypted is readable by anyone who holds it, apart from the
passwords in its vault. Encrypt your Time Machine backups.

A Time Machine disk also holds a copy of your Mac's Keychain, with this Mac's key in it. Someone
who has that disk and knows your Mac's login password can open Lifestream.
[Where the keys are](./keep-your-data-safe.md#where-the-keys-are) says more.

## Put a copy back

If Lifestream finds its database damaged or missing, it stops and says **Lifestream's database is
damaged** or **Lifestream's database is missing**, with "Put back a copy from a backup".

1. Restore Lifestream's whole folder from your backup, to the same place.
2. Click **Check again**.

Lifestream checks the folder and starts again. What came in after the backup was made is not in the
copy. If you moved the folder by hand rather than lost it, put it back where it was instead, as
[Problems and fixes](./problems.md#what-connectors-asks-of-you) says.

## Next

- [Keep your recovery key](./recovery-key.md), to keep the key a backup needs.
- [Every file and key Lifestream keeps](./what-lifestream-keeps.md), to see what else Lifestream
  keeps on your Mac.
