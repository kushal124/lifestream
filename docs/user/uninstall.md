# Uninstall Lifestream

Remove Lifestream from your Mac, your iPhone and Chrome. On the Mac, you choose whether to keep the
folder that holds everything Lifestream gathered, so you can use it again, or to erase it.

## Before you start

- If you keep Lifestream to use again, Lifestream asks you to save your recovery key first when you
  have not. On another Mac, or if this Mac's Keychain is lost, it is the only way into what
  Lifestream kept: all of it if Lifestream is encrypted, its vault if not.
  [Keep your recovery key](./recovery-key.md) says more.
- If Lifestream is on an external drive and you want to erase it, connect the drive. If Lifestream
  is encrypted, connect the drive whichever you choose: this Mac keeps a copy of your vault, and
  Lifestream puts it back in the folder before it removes the copy.

## Uninstall from your Mac

> [!WARNING]
> **Uninstall and Erase Everything…** deletes Lifestream's folder and the key in this Mac's Keychain
> that opens it. It can't be undone, and the people who make Lifestream have no copy.

1. Open **Settings** (⌘,) and click **This Mac**.
2. Beside **Uninstall Lifestream**, click **Uninstall…**.
3. Lifestream asks **Uninstall Lifestream?** Click **Uninstall** to keep its folder, or **Uninstall
   and Erase Everything…** to delete it.
4. If you chose to erase, Lifestream asks **Erase everything Lifestream kept?** Click **Erase
   Everything**.
5. If you chose to keep Lifestream's folder and have not saved your recovery key, the **Recovery
   key** window opens: **Save your recovery key before Lifestream leaves this Mac.** Click **Save as file…** or
   **Copy**, keep the key away from this Mac, then click **I've saved it**. The uninstall goes on.
   Click **Cancel uninstall** to stop: nothing is removed. If Lifestream can't make a key now, the
   uninstall goes on, and Lifestream asks you to save it when you set it up again.

A window shows each step. At the end, Lifestream says what it removed and what stays. Click
**Done**, or **Show How** to open the steps for your iPhone and Chrome on trylifestream.com. Lifestream
then quits and removes the app.

## What the uninstall removes

Whichever you choose, the uninstall removes:

- the Mac app, its background jobs and its login item;
- the secret this Mac sends to Lifestream;
- what this Mac recorded and has not sent to Lifestream yet, which is lost, and the key in your
  Keychain that encrypts it, if this Mac sent to an encrypted Lifestream;
- its logs, caches and settings, and the permissions you gave it in System Settings;
- Chat's sign-ins to your ChatGPT or Claude plan, and the AI models Lifestream downloaded;
- if you connected an agent from the internet, Lifestream's address in Tailscale. Tailscale
  itself stays;
- the folder `~/Lifestream Drop`, if it is empty. Files in it stay;
- the command `lifestream` in `~/.local/bin`, and the lines Lifestream added to your shell's startup
  files. If you changed fish's file `~/.config/fish/conf.d/lifestream.fish` since, it stays, and the
  uninstall says so.

**Uninstall and Erase Everything…** also deletes Lifestream's folder, the copy that moving its
folder left behind if it is still there, and the key in this Mac's Keychain that opens it: the key
to an encrypted Lifestream, or the key to its vault. Nothing on your other devices or in your accounts is
touched. The last window says **Everything Lifestream kept is erased. Its keys are deleted from this
Mac's Keychain.**

Erasing does not reach a copy of the folder made earlier, such as a Time Machine backup. A copy of
an encrypted Lifestream still opens with the recovery key that was current when it was made.

## If you keep its folder

What Lifestream kept stays in its folder. If Lifestream is encrypted, it stays encrypted, and the
last window says so: **What Lifestream kept stays in** the folder**, encrypted.**

Lifestream takes back the access of every device and agent: your iPhone, the Chrome extension, and
agents such as Claude. The last window then says **The devices and agents it knew can no longer
reach it.** If no device or agent had access, it says **No device or agent had access to it.**

Lifestream cannot take that access back if the drive that holds it was not connected, or if it is
encrypted and locked. When the drive is not connected, or this Mac's Keychain holds no key to it,
the question **Uninstall Lifestream?** says so first. The last window says **Your devices keep their
access until you remove them in Devices.**

This Mac's Keychain keeps the key that opens what Lifestream kept: the key to an encrypted
Lifestream, or the key to its vault.

To use Lifestream again, install Lifestream and, at **Where should Lifestream keep your data?**,
choose the same place. Lifestream opens the folder as it is. On this Mac, you type no recovery key.
If Lifestream asks you to **Allow**, click **Allow**, and choose **Always Allow** when macOS asks for
your login password. On another Mac, type your recovery key when Lifestream asks for it. Then
[pair your iPhone](./pair-your-iphone.md) and add the Chrome extension again.

## Remove the iPhone app

Deleting the iPhone app does not end its pairing: its secret stays in the iPhone's Keychain, and
Lifestream still takes it. If you remove only the iPhone app, also remove the iPhone on your Mac,
as [Unpair or remove an iPhone](./pair-your-iphone.md#unpair-or-remove-an-iphone) says.

1. Touch and hold **Lifestream** on the Home Screen.
2. Tap **Remove App**, then **Delete App**.

What the iPhone recorded and had not sent is deleted with the app.

## Remove the Chrome extension

1. In Chrome, open `chrome://extensions`.
2. Find **Lifestream** and click **Remove**, then **Remove** again.

Do this in each Chrome profile you added it to.

## Remove Lifestream from your agents

An agent you connected, such as Claude or ChatGPT, can no longer reach Lifestream while it is off
your Mac. If the uninstall could not take back its access, it reaches Lifestream again once you set
Lifestream up on the same folder. Remove Lifestream from that agent's own settings, where you added
it, so it stops trying.

## If the uninstall stops

**Lifestream wasn't uninstalled**
The uninstall stopped before it changed Lifestream, and the message says why. Fix what it names,
then click **Uninstall…** again.

**Lifestream can't erase what it kept**
The drive that holds Lifestream is not connected, and nothing was removed. Connect the drive and
uninstall again, or choose **Uninstall** to keep its folder.

**The folder** … **wasn't connected, so what Lifestream kept stays as it was.**
You chose **Uninstall** while the drive that holds Lifestream was not connected. Its folder is kept,
and the devices paired with it keep their access. An encrypted Lifestream is not uninstalled this way:
connect the drive first.

**These could not be removed:**
The uninstall went on, and lists what it could not remove. Remove each yourself.

## If the Mac app is already gone

If you deleted the app before you uninstalled, remove the rest in Terminal. Each command does
nothing when its part is already gone. Lifestream stays in its folder until you delete it yourself.

1. Stop Lifestream's background jobs:

   ```sh
   for job in home door dashboard mcp runner resource-watch; do launchctl bootout "gui/$(id -u)/org.lifestreamprotocol.$job"; done
   ```

2. Delete this Mac's secret for Lifestream:

   ```sh
   security delete-generic-password -s org.lifestreamprotocol.homelink -a pass
   ```

3. If you delete Lifestream's folder too, delete its key from your Keychain. If you keep the folder,
   skip this step: the key opens it when you set Lifestream up on this Mac again.

   If Lifestream is not encrypted, run this. It deletes the key to its vault, and an older key that a
   Mac set up with an earlier version may also hold:

   ```sh
   security delete-generic-password -s org.lifestreamprotocol.vault -a machine; security delete-generic-password -s org.lifestreamprotocol.passwords -a key
   ```

   If Lifestream is encrypted, run this. Its key is named after the id this Mac keeps in
   `~/Library/Application Support/Lifestream/home-id`, so it works with the drive connected or not:

   ```sh
   security delete-generic-password -s org.lifestreamprotocol.vault -a "machine:$(cat ~/Library/"Application Support"/Lifestream/home-id)"
   ```

4. Delete the key that encrypts what this Mac records. It is there only if this Mac sent to an
   encrypted Lifestream:

   ```sh
   security delete-generic-password -s org.lifestreamprotocol.mac -a files
   ```

5. Delete Lifestream's files, logs and caches. Run this after the Keychain steps, which read a file
   it deletes:

   ```sh
   rm -rf ~/Library/"Application Support"/Lifestream ~/Library/"Application Support"/"Lifestream Screen" ~/Library/Logs/lifestream ~/Library/Caches/face-engine ~/Library/Caches/org.lifestreamprotocol.screen-capture ~/Library/HTTPStorages/org.lifestreamprotocol.screen-capture ~/Library/HTTPStorages/org.lifestreamprotocol.screen-capture.binarycookies ~/Library/WebKit/org.lifestreamprotocol.screen-capture ~/Library/"Saved Application State"/org.lifestreamprotocol.screen-capture.savedState
   ```

6. Delete its settings:

   ```sh
   defaults delete org.lifestreamprotocol.screen-capture
   ```

7. Reset the permissions you gave it:

   ```sh
   tccutil reset All org.lifestreamprotocol.screen-capture
   ```

8. If you connected an agent from the internet, remove Lifestream's address from Tailscale:

   ```sh
   tailscale serve --https=443 --set-path=/ off
   ```

9. Remove the command `lifestream`, if it is Lifestream's, and fish's file for it:

   ```sh
   case "$(readlink ~/.local/bin/lifestream)" in *Lifestream*) rm ~/.local/bin/lifestream ;; esac; rm -f ~/.config/fish/conf.d/lifestream.fish
   ```

   Then open `~/.zprofile`, `~/.zshrc` and `~/.bash_profile` in a text editor, and delete the lines
   from `# >>> Lifestream >>>` to `# <<< Lifestream <<<`. If you have no `~/.bash_profile`, look in
   `~/.bash_login` or `~/.profile` instead.

## Next

- [Every file and key Lifestream keeps](./what-lifestream-keeps.md), to see each place the uninstall removes.
- [Lifestream's folder and its disk](./your-home.md)
