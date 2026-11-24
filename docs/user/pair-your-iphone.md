# Pair your iPhone

Pair your iPhone with your Mac so it sends what it records to Lifestream. Use this guide if you
skipped the iPhone during setup, got a new iPhone, or have an iPhone that stopped sending. The
[quick start](./quick-start.md) covers pairing during setup.

## Before you start

- Lifestream set up on your Mac.
- An iPhone with iOS 26 or later.
- Your iPhone and your Mac on the same Wi-Fi, or both connected through Tailscale, an app that
  links your own devices over the internet. To type the code instead of scanning it, they must be
  on the same Wi-Fi.

## Show the code on your Mac

Open **Connect your iPhone** from one of these places:

- **Finish setting up** › **Connect your iPhone** in the sidebar.
- **Connectors**: under **Devices**, click **Connect** beside **iPhone**.
- **Settings** › **iPhone**: click **Show code** beside **Pair an iPhone**.

It opens at the pairing code. If Lifestream is not on your iPhone yet, click **Get the app** above
the code, and scan the code that shows with your iPhone's Camera. It opens TestFlight, where you
install Lifestream. Then click **I have the app** on your Mac to show the pairing code again.

The pairing code works only while this window shows it. Keep it open until your iPhone says
**Paired**.

## Pair by scanning the code

1. At step **Scan the code**, scan the pairing code with your iPhone's Camera. Or, in Lifestream on
   your iPhone, tap **Pair with Lifestream**, then **Scan the code**.
2. If iOS asks to let Lifestream find devices on your local network, allow it. Lifestream needs it
   to find your Mac.
3. On **Pair with your Mac**, check the name your Mac will call this iPhone. Tap **Rename** to
   change it.
4. Check the Apple ID. Your Mac fills in its own, and **Change** lets you type another.
5. Tap **Pair**.

Your iPhone says **Paired**. On your Mac, it shows under **Paired iPhones**, and each of its
connectors is ticked when it is ready.

## Pair by typing the 8 digits

1. In Lifestream on your iPhone, tap **Pair with Lifestream**.
2. Type the 8 digits shown under the code on your Mac, and tap **Find your Mac**.
3. Your iPhone asks **Does your Mac show** four characters, such as **4F7K?** Your Mac shows its
   four characters under the code.
4. Type your Apple ID if you want. Health, Photos and Contacts start once you add it.
5. If the characters match, tap **Yes**. If they do not, tap **No**, and your iPhone asks about the
   next Mac it found.

If you skip the Apple ID, add it later: open **Connectors** › **Lifestream**, type it in **Apple
ID**, and tap **Add**.

Lifestream uses your Apple ID as a label: it marks your Health, Photos and Contacts as your Apple
account's, the same account as on your Mac. It does not sign in to Apple with it.

## Pair a new iPhone

Pair the new iPhone as above. If Lifestream has an iPhone already, the new one asks **Is this
iPhone replacing one of these?** and lists your iPhones.

- Tap the old iPhone to put the new one in its place. The old iPhone sends what it still holds,
  then says that you can delete the app.
- Tap **No, this is another iPhone** to keep both.

To pair one more iPhone from your Mac, click **Pair another iPhone** in **Connect your iPhone**.

## Pair again

If Lifestream stops taking what an iPhone sends, the apps say so:

- On the iPhone, **Connectors** › **Lifestream** says **Lifestream no longer knows this iPhone** ·
  **Pair it again to send**. Tap **Pair again**.
- On your Mac, the iPhone's row under **Devices** says **Pair** *its name* **again**. Click
  **Pair**.

Then pair it as above.

## Unpair or remove an iPhone

- **On the iPhone:** open **Connectors** › **Lifestream**, tap **Unpair this iPhone**, then tap
  **Unpair this iPhone** again. The iPhone stops sending, keeps recording, and keeps what it records.
  You can pair it again later.
- **On your Mac:** open **Settings** (⌘,) and click **iPhone**. Beside **This iPhone**, click
  **Remove**, then **Remove phone**. Your Mac says: "It stops recording once it has synced what it
  holds. Its history stays in Lifestream."

Either way, what Lifestream already holds from the iPhone stays there.

## If it does not pair

| Your iPhone says | What to do |
|---|---|
| **No Mac found on this Wi-Fi. On Tailscale, scan the code instead.** | A typed code finds your Mac only on the same Wi-Fi. Join your Mac's Wi-Fi, or scan the code. |
| **Can't reach your Mac** | Check that your Mac is awake, and that both are on the same Wi-Fi or on Tailscale. If you did not allow Lifestream on your local network, tap **Open Settings** beside **Local network** and allow it. Then tap **Try again**. |
| **This isn't your Mac** | Another Mac answered. Tap **Scan again**, and scan the code on your own Mac. |
| **This code no longer pairs** | The code was used, it expired, or someone typed it wrong too many times. Your Mac shows a new one. Scan it, or type its 8 digits. |
| **Your Mac needs a newer Lifestream on this iPhone. Update the app, then pair.** | [Update the iPhone app](./update.md#the-iphone-app), then pair. |

## What your iPhone records

Each connector starts once you allow its permission. Your iPhone asks for the first five during
its setup, and for the others the first time you use them.

| Connector | Asks for | What it records |
|---|---|---|
| Location | Location, Always | Where you go, point by point |
| Motion | Motion & Fitness | When you walk, run, drive or stay still, and your daily steps |
| Health | Health | Every sample you allow, such as sleep, steps and heart |
| Photos | Photos, Full Access | Every photo and video, with when and where you took it |
| Contacts | Contacts | Every contact card, with its photo |
| Check-ins | Notifications | Your answers about your day, and your reaction-time tests |
| Voice notes | The microphone | Each voice note you start |
| Camera | The camera | Each photo you take with the app or attach to a note |
| Lifestream notes | Nothing | Each note and folder you keep in the app |
| Battery | Nothing | The app's battery use, and iOS's energy and crash reports |

## Next

- [Connectors](./connectors/README.md), to pause a connector or change its settings.
- [Update Lifestream](./update.md)
