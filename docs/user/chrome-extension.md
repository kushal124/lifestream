# Add the Chrome extension

The Chrome extension lets Lifestream read your Claude and ChatGPT conversations and your WHOOP data
in your own Chrome, signed in as Chrome already is. Exports, such as a Spotify export, do not need
it: you hand them over as [Bring in your past from an export](./imports.md) says.

## Before you start

- Lifestream on your Mac.
- Chrome, or a browser like it, on the same Mac.

## Add the extension

1. Open **Connectors**. Under **Devices** in the side column, click **Add** beside **Chrome**, or
   click **Add Lifestream to Chrome** under **Finish setting up** in the sidebar. The window **Add Lifestream
   to Chrome** opens, listing the sites it reads.
2. If your Mac has more than one browser like Chrome, pick one in the **Browser** menu.
3. Click **Add to Chrome**. The extension's page in the Chrome Web Store opens in that browser.
4. Add the extension there.

Chrome asks to "read and change data on websites": that is how it opens these sites. Lifestream
opens a site only for one you connect, in a small window of its own, and never reads your other
tabs.

## Connect it to Lifestream

Once it is added, the extension asks Lifestream on your Mac to connect. Lifestream shows **Chrome
wants to connect**. Click **Allow**.

The window then says **Connected to Lifestream in Chrome**, and the extension's row on **Connectors**
says **Running in Chrome**. Nothing is read yet: each site starts only when you connect it.

If you click **Not now**, the window says **Chrome asked to connect.** Click **Allow Chrome** when
you are ready.

## Pair it from another computer

The extension connects by itself only in Chrome on the Mac that runs Lifestream. In Chrome on
another computer, pair it with the code that pairs an iPhone. The window names only the iPhone, but the
same code pairs a browser.

1. On the Mac, open **Settings** › **iPhone** and click **Show code** beside **Pair an iPhone**.
   Under **Pair it with this Mac**, the window says **Or type** an 8-digit code **on your iPhone**.
   Keep the window open: the code works only while it shows.
2. In Chrome on the other computer, click Lifestream's icon in the toolbar, then **Pair with another
   computer…**. The extension's settings open.
3. Under **Pair with another computer**, type the Mac's address in **Computer** and the code in
   **Code**, then click **Pair**.

## Connect the sites it reads

The window lists Claude and ChatGPT under **Its sites**. For each one you want:

1. If its line says **Not signed in to** the site **in Chrome**, click **Sign in**. Sign in on the
   page that opens, then come back.
2. When its line says **Signed in to** the site **in Chrome**, click **Connect**.

The site's line then says **Reading your messages**, and your conversations start to arrive.

WHOOP needs your WHOOP email and password. Open **Connectors**, then **WHOOP**, and click
**Set up**.

You can also choose sites in Chrome. Click Lifestream's icon in Chrome's toolbar. Under
**Accounts**, turn a site's switch on to read it, or off to stop. **Set up all** turns on every
site at once.

The extension reads in a minimized Chrome window of its own. It does not use your tabs.

## When it stops

Each site's connector shows a line on **Connectors**, and the extension's popup in Chrome says where
it stands with Lifestream. For the lines every connector can show, see
[Connectors](./connectors/README.md#messages-every-connector-can-show).

| You see | What it means and what to do |
|---|---|
| **Chrome is closed** | The extension reads only while Chrome is open. Open Chrome. |
| **Chrome is busy** | The extension is already reading as many sites as it can. It goes on when one finishes. |
| **Sign in to** the site **in Chrome** | Chrome is signed out of the site. Click **Open**, and sign in: Lifestream reads the site once the page loads signed in. **Try now** reads it again at once. |
| **Another** site **account** | Chrome is signed in to a different account of that site. Click **Read it too** to read that account as well, or **Not this one** to leave it. |
| **Turn on** the site **in Chrome** | The site is not connected in the extension. Click **Connect**. |
| **Add Lifestream to Chrome** | No extension is connected to Lifestream. Click **Add to Chrome**, and add it as [Add the extension](#add-the-extension) says. |
| **Allow Lifestream on** a site **in Chrome** · **Click Allow in Lifestream’s popup in Chrome** | Chrome holds back a site you connected. Click **Allow** on the page the extension opened, or click Lifestream's icon in Chrome's toolbar, then **Allow**. Lifestream reads the site once you allow it. |
| **Lifestream isn't allowed on** a site **in Chrome yet** | Chrome has not let the extension on that site, so Lifestream cannot see if you are signed in. Click **Connect**, then **Allow** when Chrome asks. |
| **Not connected** · **Open Lifestream on this Mac.** | The popup cannot find Lifestream. Open Lifestream on your Mac. |
| **Connecting** · **Allow it in Lifestream on this Mac.** | Lifestream is asking you to connect the extension. Click **Allow** in Lifestream. |
| **Can't reach Lifestream** | Lifestream on your Mac is not answering. Open it, and check that Lifestream is running. |
| **Lifestream on this Mac doesn't know this browser now** | Lifestream no longer accepts this extension. Remove the extension and add it again. |
| **Waiting for Lifestream** | The extension is newer than Lifestream. See [Update Lifestream](./update.md#the-chrome-extension). |

## Next

- [Update Lifestream](./update.md#the-chrome-extension)
- [Remove the Chrome extension](./uninstall.md#remove-the-chrome-extension)
- [Connectors](./connectors/README.md)
