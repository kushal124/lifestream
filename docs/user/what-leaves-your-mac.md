# What leaves your Mac

Lifestream has no service of its own that receives your data, and no account to sign in to. It
keeps your data on your Mac. Parts of it leave only when you set something up that needs them, such
as an AI model at a company or an agent, and this page names each one.

## At a glance

| When | What leaves | Who receives it |
|---|---|---|
| Never | Your keys, and Lifestream's folder as a whole. Lifestream's own code sends no analytics and no crash reports. | Nobody |
| When you set it up | Single items an AI model reads, what Chat and your agents read, a place to name, your sign-in to a connector | The company you picked. Lifestream first hides personal details as you set it: by default all of them for a model, and all but names for an agent. Sound can't be hidden. |
| Always | The hourly update check, and the area of each map you open | Lifestream's update server, and the map's company |

The rest of this page gives each case: who receives it, when, and how to stop it.

## Everything that can leave

| What leaves | Who receives it | When | Personal details hidden | To stop it |
|---|---|---|---|---|
| Items a connector's AI work reads: photos, emails, voice notes, long messages from AI chats, your screen | OpenAI for your ChatGPT plan, Anthropic for your Claude plan, or OpenRouter and the model's maker for your OpenRouter key | As each item arrives, once a model is ready | Yes, but not voice notes | Set the work's **Model** to **Off**, or to a model on your Mac |
| Your Chat questions, and what Chat reads to answer them | The same companies: Chat always uses one | Each question | Yes, at Chat's level | Sign out of both plans, and remove the OpenRouter key |
| Your voice in Chat, with **Scribe v2** | OpenRouter and ElevenLabs | Each voice message | No: sound can't be hidden | Pick **Parakeet** for **Voice** in Chat's model menu |
| What an agent reads | The company that runs the agent, such as Anthropic for Claude | Each read | Details yes, names no, unless you change **Hides** | Disconnect the agent |
| An agent's requests from the internet | Tailscale, which carries them | Each request | Same as the row above | On the **Agents** page, click **Turn off** |
| Where a place is, and the words you type for its name | Google | Only once you add a Google key | No | Add no Google key |
| The area a map shows | OpenFreeMap in the Lifestream window, Apple in the iPhone app | Each time a map shows | Nothing of yours but the area | No setting |
| Where a place is, when you name it on your iPhone | Apple | Only while your iPhone cannot reach Lifestream | No | Name the place when your iPhone reaches Lifestream |
| A page a link points to | That website | When Chat opens a link in your question or in what it reads | No | Leave the link out |
| Your sign-in, and requests for your own data | The connector's company, such as Google for Gmail | Each time the connector reads | Not needed: it is your account | Disconnect the connector |
| An update check | Lifestream's update server, `get.lifestreamprotocol.org` | Every hour | Holds only your internet address and the app's version | No setting |
| Downloads | npm for Codex and Claude Code; GitHub, Ollama and Hugging Face for models on your Mac | When you click **Connect** beside a plan, or **Download** beside a model | Nothing of yours is sent | Do not click them |

Your iPhone sends what it records only to Lifestream, over your Wi-Fi or
[through Tailscale](./reach-from-anywhere.md). The Chrome extension sends what it reads only to the
Lifestream it is paired with.

## What the people who make Lifestream receive

Lifestream's code sends no analytics and no crash reports. The people who make it see only these:

- the update check: your internet address and the version of the Mac app;
- visits to the website `trylifestream.com`, which Cloudflare serves;
- how many people installed the Chrome extension, from the Chrome Web Store;
- for the iPhone app, which comes through TestFlight: its crash reports, how often you open it, and
  the feedback you send, which Apple passes on under TestFlight's terms.

The crash and energy reports that macOS and iOS give Lifestream stay with you. The Mac app keeps
them on your Mac, and your iPhone sends them to Lifestream as the [Battery](./connectors/battery.md)
connector.

## What a connector sends to an AI model

A connector's **AI** section sends single items to a model. These connectors send something, and
each connector's page says exactly what:

- Photos: [Photos](./connectors/photos.md#what-a-model-reads),
  [Google Photos](./connectors/google-photos.md#what-a-model-reads),
  [Camera](./connectors/camera.md#what-a-model-reads)
- Chats: [iMessage](./connectors/imessage.md#what-a-model-reads),
  [WhatsApp](./connectors/whatsapp.md#what-a-model-reads)
- Voice: [Voice notes](./connectors/voice-notes.md#what-a-model-reads)
- Mail: [Gmail](./connectors/gmail.md#what-a-model-reads)
- AI chats: [ChatGPT](./connectors/chatgpt.md#what-a-model-reads),
  [Claude](./connectors/claude-ai.md#what-a-model-reads)
- Your Mac: [Screen](./connectors/screen.md#what-a-model-reads), with
  [Keyboard and mouse](./connectors/input.md#what-a-model-reads) and [Mac events](./connectors/machine.md#what-a-model-reads)

Who receives an item depends on the model that reads it:

| The model | Who receives what it reads |
|---|---|
| Your ChatGPT plan | OpenAI |
| Your Claude plan | Anthropic |
| A model through your OpenRouter key | OpenRouter, and the company that makes the model: Google for **Gemini 3.8 Flash**, OpenAI for **GPT-6 Luna**, ElevenLabs for **Scribe v2** |
| A model under **On this Mac** | Nobody. It runs on your Mac. |
| A model under **On** *another computer's name* | That computer, which runs the model for Lifestream. |
| **Custom server** | The computer at its address. Nobody, if that address is this Mac. |

Each model menu says the same in a note beside each model: **Sent to** a company, or **Stays on**
your computer. Lifestream runs the programs your plans need, Codex and Claude Code, with their
analytics and update checks turned off. **Search by meaning** runs on your own computer and sends
nothing to a company.

Until a model is ready, no item goes to a model. The first model you make ready becomes the default
for each kind of work it can do, and every connector setting starts at **Default**. So if you
connect your ChatGPT or Claude plan during setup, your photos, your emails, long AI-chat messages,
and the text on your screen with what you typed start going to OpenAI or Anthropic as soon as the
plan is connected. Each connector sends its items from 30 days before you added it onwards.

A later setup screen, **What should a model read?**, shows these settings for each connector a
model reads, so you can turn one off. What went before you change a setting stays sent.

**Describe now** or **Transcribe now** on one photo or voice note sends that item to the model the
button names, even when the connector's setting is **Off**.

## What is hidden before sending

Before an item goes to a model off your Mac, Lifestream hides its personal details. Names,
phone numbers, email addresses, street addresses, account numbers and the sign-in parts of links
become placeholders such as `[[Person 3]]`, and the model still reads what was said. In a picture,
faces are covered and text with a personal detail is filled in. A model that runs on your own
computer gets each item as it is.

Sound can't be hidden, so voice notes are the exception. A connector's voice notes, from Voice
notes, iMessage or WhatsApp, go to a model off your Mac only when their **Personal details** is
**Don't hide**. Until then, the work says **Audio cannot be hidden**. To keep voice notes on your
Mac, choose a speech model that runs on it, such as **Parakeet**.

Hiding finds most personal details, not all. Codes, account numbers and names Lifestream has never
seen can still leave. You choose how much is hidden in two places:

- **Settings** › **Privacy** › **Hide personal details** sets it for everything. **Hide what
  Lifestream knows** is the default: it replaces numbers, addresses, links, passwords and the names
  in People. **Hide with a hiding model** also downloads a model of about 1.6 GB that finds names
  Lifestream has never seen, English first. **Don't hide** sends each item as it is.
- In a connector's window, click a job under **AI**. **Personal details** sets that job alone:
  **Hide all**, **Keep names**, **Don't hide**, or **Default**, which follows **Settings** ›
  **Privacy**.

**What left Lifestream today**, in **Settings** › **Privacy**, says for each company how many items
went and how many details were hidden. **Earlier** covers the 13 days before. Click **View**, then
an item, to see **What was sent**, as the model got it.

## What Chat sends

Chat always uses a model at a company: your ChatGPT plan, your Claude plan, or a model through your
OpenRouter key. No model on your Mac can answer Chat. Each question sends the model your question,
the conversation so far, and everything Chat reads to answer it. Chat hides personal details in all
of it. The chip beside the model, under the box, shows how much: a new conversation takes the
**Chat** setting in **Settings** › **Privacy**. To stop Chat sending anything, open **Settings** › **AI models**, click **Sign out**
beside each plan and **Remove** beside the key.

Each photo goes as a new picture, without its time, place or camera details. Faces are covered, and
a person you named in People is tagged, so the answer can still name them. Chat tells the model when
and where a photo was taken, with the place hidden. Small or handwritten text Lifestream can't read
stays in the photo.

A voice note you send in Chat can't be hidden. With **Parakeet**, it never leaves your Mac. With
**Scribe v2**, its sound goes as it is to OpenRouter, which passes it to ElevenLabs. If Chat's chip
is set to hide anything, **Voice** in Chat's model menu shows a warning mark, since your voice is
not hidden. Your words, once written out, are hidden like typed words. Your photos and voice notes are kept in Lifestream with the
conversation.

To see what the model got for one answer, click the eye beside **Copy** under it, as
[Chat with your life](./chat.md#follow-an-answer-back-to-your-data) says.

If your question or something Chat reads holds a link, Chat can open that page from your Mac. It
never opens an address on your own network. A question of 4,000 characters or more also goes to
your **Text** default, which shortens it for Timeline.

## What an agent reads

An agent reads Lifestream through [the tools an agent gets](./agent-tools.md). Everything it reads
goes to the company that runs it, such as Anthropic for Claude or OpenAI for ChatGPT. This is also
true of an agent on your Mac, such as Claude Code.

A new agent sees names. Its **Hides** starts at **Details**: Lifestream hides phone numbers,
addresses and other details, and shows the names of people. Connectors and Chat hide names too. To
hide names from an agent, set its **Hides** to **Names and details**, as
[Choose what an agent reads](./choose-what-an-agent-reads.md#what-an-agent-reads) says.

Claude, ChatGPT, Muse, Grok Bot and Instinct reach your Mac from the internet, through Tailscale's
Funnel.
[Connect an agent](./connect-an-agent.md) says how to connect an agent, and how to disconnect one.

## What each company keeps

Each company keeps and uses what it receives under its own terms. Lifestream asks none of them for
special handling. With OpenRouter, it does not ask for providers that keep nothing, and it does not
limit which providers may serve a request. Check these settings at each company:

- **ChatGPT plan:** in ChatGPT, **Settings** › **Data controls** › **Improve the model for
  everyone** decides whether OpenAI trains on your conversations.
- **Claude plan:** in Claude, **Settings** › **Privacy** › **Help improve Claude** decides whether
  Anthropic trains on your chats.
- **OpenRouter key:** OpenRouter's privacy settings, at `openrouter.ai/settings/privacy`, decide
  which providers may serve your requests, and whether they may keep them or train on them. These
  settings cover Google, OpenAI and ElevenLabs when they serve your key.
- **An agent:** the agent's own app, such as Claude or ChatGPT, under the same settings as above.

What a company already received stays with it. Erasing something in Lifestream does not reach it.

## Next

- [How Lifestream keeps your data safe](./keep-your-data-safe.md), to see who can read what stays on your Mac.
- [Choose which AI models read your data](./ai-models.md)
- [Connectors](./connectors/README.md#settings-every-connector-has), to set what a model does with a connector.
