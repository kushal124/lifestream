# Keep your recovery key

Your recovery key opens Lifestream when this Mac's key cannot, such as on a new Mac. Save it where
you will find it, away from this Mac. This guide saves it, checks it, unlocks Lifestream with it,
and says what to do if a key is lost or someone else may have it.

> [!WARNING]
> If you lose your recovery key and this Mac's key, nobody can open an encrypted Lifestream: not
> you, and not the people who make Lifestream. A Lifestream that is not encrypted loses only the
> passwords in its vault.

[How Lifestream keeps your data safe](./keep-your-data-safe.md#where-the-keys-are) says what the
two keys open.

## Save your recovery key

Setup shows your recovery key before it makes Lifestream's folder. A Lifestream set up by an older
version without encryption shows the **Recovery key** window the first time a connector needs a
password: it shows **Create your vault**, and you click **Create**.

1. Read the key: 52 letters and digits, in groups of four. Setup shows it once.
2. Click **Copy** or **Save as file**.
3. Keep the key away from this Mac, such as on paper or in a password manager.
4. Click **Continue**.

Until you click **Continue**, that key is not your recovery key. If you go back, setup makes
nothing, and shows a new key when you continue again. Lifestream refuses a file saved inside its
own folder, since a copy of the folder would then carry its own key.

## Check where your key stands

Open **Settings** (⌘,) and click **Recovery key**. The row says where your key stands:

- **Saved**, with the day: click **Make a new key…**. Opening the window makes no new key. In it,
  **Check your recovery key…** tells you whether a key you type opens Lifestream. **Make a new
  key** makes another; your old key works until you save the new one.
- **Not saved**: click **Show a new key…**, and save that one. The menu bar menu says **Recovery
  key not saved** until you do.
- **No vault yet**: click **Create…** to make the vault and its key. An encrypted Lifestream never
  shows this.
- **Locked on this Mac**: click **Allow** to open Lifestream with this Mac's key, or **Unlock…** to
  type your recovery key.

Each key has a number and a date, such as **recovery key 2, made on 17 November 2026**, and the
file you save is named by them. A new key does not open a copy of Lifestream's folder made before
it, such as a Time Machine backup: that copy opens only with the key that was current then. If you
keep an old copy, keep its key with it.

## Unlock Lifestream

Lifestream is locked when it cannot read its key from this Mac's Keychain, such as on a new Mac or
after your Mac's login password was reset without the old one.

**An encrypted Lifestream** reads and writes nothing while it is locked. The menu bar menu says
**Lifestream is locked**, and the Lifestream window shows the same page.

1. If this Mac's Keychain holds the key, click **Allow**.
2. When macOS asks for your login password, type it and choose **Always Allow**.
3. Otherwise, or if you click **Use your recovery key instead**, type your recovery key into
   **Recovery key**, and click **Unlock**.

Lifestream says **Opening Lifestream…**, then opens where it stopped. While it is locked, your Mac
and your iPhone keep what they record and send it once it opens. Chat and your agents say
**Lifestream is locked: unlock it on your Mac.**

If the window says **This Mac couldn't keep Lifestream's key**, Lifestream is open but cannot keep
its key in your Keychain, and the window says why. Fix what it names, then click **Try again**.

**Without encryption**, only the vault locks. The menu bar menu says **Passwords are locked on this
Mac**. Click it, then click **Allow**, and choose **Always Allow** when macOS asks for your login
password. If Lifestream asks for your recovery key instead, type it into **Recovery key**, and
click **Unlock**. Meanwhile, connectors that need a password wait and say **Waiting for your
passwords to unlock**. Every other connector goes on.

## If this Mac cannot open what it records

When your Mac sends to an encrypted Lifestream, it encrypts what it records with a key of its own in
your Keychain, until Lifestream takes it. If macOS does not let Lifestream read that key, or the key
is gone, the menu bar menu says so. [Keys and encryption](./problems.md#keys-and-encryption) gives
each message and what to do.

## If you lose a key

While you have this Mac's key or your recovery key, you lose nothing. This Mac's key is lost when
its login password is reset without the old one, on a new Mac, when macOS is set up again, or when
someone deletes it from the Keychain. Migration Assistant and a Time Machine restore may not bring
it to a new Mac, so keep your recovery key where you will find it.

**An encrypted Lifestream** opens only with one of the two keys. If you lose both, nobody can open
it, and the window says so.

**Without encryption**, if you lose both keys, you lose the passwords in the vault, and nothing
else. To use passwords again, start a new vault:

1. Open **Settings** › **Recovery key**, then **Unlock…**, then **Lost your recovery key?**.
2. Click **Start a new vault**. Lifestream deletes the passwords it can no longer open. If they may
   still open on another of your Macs, the window names it first: open Lifestream there instead to
   keep them.
3. Save the new recovery key the window shows.
4. Type each password again when its connector asks.

On a computer without the Mac app, run `lifestream vault new`. It deletes nothing if that computer
can still open the vault, and otherwise asks you to type `delete` first.

## If someone may have your recovery key

A new key is not enough. The window says so: **If someone else may have your key, a new key is not
enough.** Whoever has your old key and an older copy of Lifestream's folder can open that copy.

On an encrypted Lifestream, the key that encrypts your data stays the same when you make a new
recovery key. So with that older copy, they can also read a newer copy of Lifestream's files.
Lifestream has no way to encrypt them again under a new key. Keep every copy of Lifestream's folder
where nobody else can reach it.

1. Make a new key, and save it.
2. At each company whose password Lifestream keeps, change your password, and sign Lifestream out
   of any connection you signed in to. Then type the new password in Lifestream.
3. Delete copies of Lifestream's folder you no longer need.

## Next

- [How Lifestream keeps your data safe](./keep-your-data-safe.md)
- [Back up Lifestream](./back-up.md), to keep a copy of Lifestream's folder and the key it needs.
- [Uninstall Lifestream](./uninstall.md), to remove Lifestream and keep its folder and its key.
