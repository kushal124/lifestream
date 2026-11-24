# Every file and key Lifestream keeps

Lifestream keeps your life in one folder, and a few working files in your Mac's own Library. This
page lists each place, each key in your Keychain, and what your iPhone keeps, with whether each is
encrypted.

## Files and folders

| Place | What it holds | Encrypted |
|---|---|---|
| Lifestream's folder, `~/Lifestream` or the folder you chose | Everything Lifestream gathered: its database, your photos and files, your days, its search, and the vault of passwords your connectors use | All of it, if Lifestream is encrypted. Otherwise only the vault. |
| `~/Library/Application Support/Lifestream` | Lifestream's programs and their updates, the AI models you downloaded, Codex and Claude Code with your ChatGPT or Claude plan sign-in, the copies Lifestream works on while a job runs, and caches that keep it fast | The caches, if Lifestream is encrypted. Never the plan sign-in or the working copies. |
| `~/Library/Application Support/Lifestream Screen` | What this Mac records, such as your screen, your keys and clicks and audio, until Lifestream takes it | Yes, if this Mac sends to an encrypted Lifestream |
| `~/Library/Logs/lifestream` | Lifestream's logs: what it did and when | No |
| `~/Library/Caches/face-engine` | The files of the model that finds faces in your photos | No |
| `~/Lifestream Drop` | Files you put there for Lifestream to bring in. They stay as you left them. | No |

What is not encrypted in this list is protected by FileVault, macOS's disk encryption, when it is
on. [How Lifestream keeps your data safe](./keep-your-data-safe.md#what-stays-readable) says what
this means for a stolen Mac.

To see where Lifestream's folder is, open **Settings** (⌘,) and click **Storage**. **Folder**,
under **Location**, shows it. [Lifestream's folder and its disk](./your-home.md) says how big it
gets and what happens when its disk fills.

## Keychain items

Lifestream keeps two kinds of key in your Mac's Keychain, under your login password:

- **This Mac's key**, which opens Lifestream, or its vault if Lifestream is not encrypted. Its
  service is `org.lifestreamprotocol.vault`.
- **The key that encrypts what this Mac records**, if this Mac sends to an encrypted Lifestream.
  Its service is `org.lifestreamprotocol.mac`.

Your recovery key is not kept anywhere on your Mac. [Keep your recovery key](./recovery-key.md)
says where to keep it.

## On your iPhone

The iPhone app keeps what it records in its own storage until Lifestream takes it. iOS encrypts it,
and iPhone backups leave it out. The secret your iPhone sends to Lifestream is in the iPhone's
Keychain, and never in a backup.

## Next

- [Back up Lifestream](./back-up.md), to keep a copy of Lifestream's folder.
- [How Lifestream keeps your data safe](./keep-your-data-safe.md)
- [Uninstall Lifestream](./uninstall.md), to remove each of these places.
