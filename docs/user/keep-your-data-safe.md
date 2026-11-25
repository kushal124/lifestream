# How Lifestream keeps your data safe

Lifestream keeps your data in one folder on your Mac. That folder is encrypted: it opens only with
this Mac's key or your recovery key, and the people who make
Lifestream hold neither. This page says who can and cannot read your data, where the keys are, and
what listens on your network. What leaves your Mac on purpose, such as to an AI model, is on
[What leaves your Mac](./what-leaves-your-mac.md).

## Who can read your data

Every new Lifestream is encrypted. A Lifestream set up by an older version may not be.

| Who | Encrypted | Not encrypted |
|---|---|---|
| Someone who takes your Mac while it is off, or the drive Lifestream is on | Nothing in Lifestream's folder, unless they have your Mac and know its login password, which opens [this Mac's key](#where-the-keys-are). If FileVault is off, [a few files on your Mac's own disk](#what-stays-readable). | Everything but the passwords in the vault, unless FileVault or an encrypted drive covers the folder. |
| Someone with a copy of Lifestream's folder, such as a backup or a cloud drive | Nothing, without your recovery key or this Mac's key. | Everything but the passwords in the vault. |
| Another account on your Mac | Nothing in Lifestream's folder, and nothing through the Lifestream window, which answers only with a key kept in that folder. | Nothing: macOS lets only your account open the folder. If its disk ignores ownership, Lifestream says **Other accounts can read Lifestream**. |
| Someone on your Wi-Fi | Nothing, unless an agent reaches Lifestream over your Wi-Fi: [its **Key** and every answer it gets](#what-listens-on-your-network) travel unencrypted. Your devices talk to Lifestream over an encrypted connection. | The same. |
| Someone on the internet | Nothing. While your agent address is on the internet, they reach only the page where an agent asks to sign in, and you approve each sign-in. | The same. |
| A web page you open in your browser | Nothing. It cannot reach Lifestream on your Mac. | The same. |

## What Lifestream does not protect you from

- A program you run on your Mac, and an administrator of your Mac.
- Someone who uses your Mac while you are logged in.
- An AI model or an agent you let read Lifestream: what it reads, it keeps.
- Someone who has your Mac's login password and a copy of your Keychain, such as your Time Machine
  disk, as [Where the keys are](#where-the-keys-are) says.

## Encryption

Encrypted files are unreadable without their key. Setup encrypts every new Lifestream, with no
choice to make: you keep a recovery key, and if you lose it and this Mac’s key, nobody can open your
Lifestream. If the folder you pick already holds Lifestream, setup opens it as it is. No update,
command or setting turns encryption on or off for a folder later.

To encrypt a Lifestream that is not encrypted, [uninstall Lifestream](./uninstall.md) and keep its
folder, then set Lifestream up again in an empty folder. The new
Lifestream starts empty: nothing moves across from the old folder. Connectors bring in your past
again, as far back as each one reaches.

## What encryption covers

An encrypted Lifestream encrypts everything in its folder: its database, your photos and files,
your days, its search, and the passwords your connectors use. It also encrypts the caches it keeps
on your Mac, and what your Mac records before it sends it. Lifestream encrypts these files itself,
with AES-256 and AEGIS-256, standard encryption, whether or not the disk is encrypted.

Encryption covers files at rest. It does not cover what Lifestream sends: a model or an agent gets
what it reads unencrypted, apart from the personal details Lifestream hides.

### What stays readable

A few things stay readable on the disk:

- how big Lifestream's files are, how many there are, and when they changed;
- the folder's id and the day it was made, in its file `HOME.json`;
- the key of the certificate Lifestream shows your iPhone on your Wi-Fi. Someone who has a copy of
  Lifestream's folder and is on your iPhone's network can pose as Lifestream to your iPhone;
- the copies Lifestream works on while a job runs, your ChatGPT or Claude plan sign-in, and
  Lifestream's logs. They are on your Mac's own disk, not in Lifestream's folder.

FileVault, macOS's disk encryption, covers that last group. If FileVault is off, Lifestream shows
**This Mac's disk isn't encrypted**: "Turn on FileVault: Lifestream doesn't encrypt its working
copies, temp files, your ChatGPT or Claude sign-in or its logs". If Lifestream is on an external
drive that is not encrypted, it shows **Lifestream encrypts its files itself**: "Move Lifestream to
an APFS (Encrypted) disk to cover what was on it before".
[Every file and key Lifestream keeps](./what-lifestream-keeps.md) lists each place.

### If you do not encrypt

Lifestream then encrypts only its vault. The vault holds each password, app password, sign-in and
API key your connectors and Chat use, such as a Gmail app password or an OpenRouter key. Your
ChatGPT or Claude plan sign-in is not in the vault: Codex or Claude Code keeps it in Lifestream's app
folder on your Mac. Lifestream never saves a password unencrypted: while the vault is locked, it
refuses to save one.

Everything else is ordinary files, which anyone who can read the folder can read. To protect them,
turn on FileVault in macOS's System Settings. If it is off, Lifestream shows **This Mac's disk isn't
encrypted**. If Lifestream is on an external drive that is not encrypted, it shows **Lifestream's
disk isn't encrypted**: move Lifestream to an APFS (Encrypted) drive.

## Where the keys are

Lifestream's key is never stored as it is. Two keys open it, and Lifestream keeps no other copy:

- **This Mac's key**, in your Mac's Keychain. When Lifestream starts, it uses this key and asks
  you nothing.
- **Your recovery key**, which only you hold.

On an encrypted Lifestream, these keys open everything it keeps. Otherwise they open the vault. If
you lose both, nobody can open an encrypted Lifestream, not you and not the people who make
Lifestream.

Your Mac's login password protects its Keychain. Time Machine and Migration Assistant copy the
Keychain. So someone who has your Time Machine disk, or this Mac's disk without FileVault, and knows
that password, can open Lifestream. Use a strong login password, turn on FileVault, and encrypt your
Time Machine backups.

## Your recovery key

The recovery key is 52 letters and digits. You need it on a new Mac, or on this Mac after its
Keychain lost Lifestream's key. An encrypted Lifestream shows it during setup, before it makes its
folder. [Keep your recovery key](./recovery-key.md) says how to save it, check it, make a new
one, and what to do if you lose it.

## When Lifestream is locked

Lifestream is locked when it cannot read its key from this Mac's Keychain, such as on a new Mac or
after your Mac's login password was reset without the old one. An encrypted Lifestream then reads
and writes nothing until you click **Allow** or type your recovery key. Without encryption, only
the vault locks. [Unlock Lifestream](./recovery-key.md#unlock-lifestream) gives the steps.

## What listens on your network

Lifestream answers on three addresses on your Mac, the same whether it is encrypted or not:

- **For your devices**, such as your iPhone, on every network your Mac joins. A device must send
  the secret it made when you paired it. On your Wi-Fi, Lifestream encrypts the connection; over
  Tailscale, Tailscale encrypts it.
- **For agents**, on port 4681, on every network your Mac joins. An agent must send its **Key**.
  This connection is not encrypted, so anyone on the same Wi-Fi can read a **Key** sent over it,
  and every answer the agent gets. Use a **Key** only on this Mac, or from your other devices over
  Tailscale, which encrypts the connection.
- **The Lifestream window**, only on this Mac.

When you connect an agent from the internet, Tailscale's Funnel gives the agent address a public
address there. It puts there only what an agent needs: the agent address, the skill, and the
sign-in pages. Each sign-in waits for your yes on your Mac or your iPhone.
[Connect an agent](./connect-an-agent.md#your-internet-address) says when the address is on, and
how to turn it off.

## How your devices prove who they are

When you pair a device, it makes its own secret: a long, random value. Lifestream keeps only a
fingerprint of it, from which the secret cannot be worked out. The device sends the secret with
every request, and Lifestream takes nothing from a device without a secret it knows. The pairing
code works once, only while your Mac shows it, and 5 wrong tries end it.

Your iPhone checks Lifestream too. The pairing code carries the fingerprint of Lifestream's
certificate, which Lifestream shows to prove who it is. On your Wi-Fi, your iPhone talks only to a
computer that shows that certificate. If you type the 8 digits instead of scanning the code, the 4 characters
your iPhone asks you to match are that check.

Your iPhone keeps its secret in its Keychain, never in a backup. Deleting the iPhone app does not
end its pairing: to end it, remove the iPhone in **Settings** › **iPhone** on your Mac. The Mac app
keeps its secret in a file only your Mac account can read, which Time Machine leaves out. On an
encrypted Lifestream, that file is encrypted too. When you remove a device, Lifestream takes only
what the device still holds, then stops taking its secret. An agent gets a secret of its own:
[Connect an agent](./connect-an-agent.md) says how to give one and take it back.

## What the iPhone app keeps

The iPhone app keeps what it records in its own storage on the iPhone, and sends it from there to
Lifestream. iOS encrypts these files, and after the iPhone restarts, nothing can read them until you
unlock it once. iPhone backups leave them out, whether to iCloud or to a computer. An iPhone
restored from a backup starts with none of them, and you [pair it again](./pair-your-iphone.md).

## Check it yourself

You do not have to take this page's word for it.

- **Settings** › **Privacy** › **What left Lifestream today** counts, for each company, the items
  that went and the details hidden in them. Click **View**, then an item, to see **What was sent**.
- In Chat, the eye beside **Copy** under an answer shows what the model got for it.
- On **Agents**, an agent's **History** shows every read and what left Lifestream for it.
- Lifestream is open source. [The privacy package](../../packages/privacy/) holds the code that
  hides personal details, and [the families](../../packages/families/) hold every prompt that
  goes to a model. These are written for developers.
- [SECURITY.md](../../SECURITY.md) says how to report a security problem.

## Next

- [What leaves your Mac](./what-leaves-your-mac.md), to see what goes to AI models, agents and other companies.
- [Keep your recovery key](./recovery-key.md), to save, check or replace your key.
- [Back up Lifestream](./back-up.md), to keep a copy of Lifestream's folder.
