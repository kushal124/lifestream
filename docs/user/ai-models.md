# Choose which AI models read your data

AI models describe your photos, transcribe your voice notes and sum up your emails and screen.
This guide connects the models you want, picks which one does each job, and turns them off. You set
them in **Settings** › **AI models**: press ⌘, in Lifestream on your Mac. Chat picks its model on
its own page, as [Chat with your life](./chat.md#pick-the-model) says.

## Ways to reach a model

Each way has its own part of **AI models**, and reaches a fixed model for the work connectors ask
for. In a model menu, each model shows its name and, after it, who receives what it reads.

| Part of **AI models** | Choice | Model | What it reads | Sent to |
|---|---|---|---|---|
| **Subscriptions** | Your ChatGPT plan | GPT-6 Luna | Pictures and text | OpenAI |
| **Subscriptions** | Your Claude plan | Claude Haiku 5.5 | Pictures and text | Anthropic |
| **API keys** | An OpenRouter key | Gemini 3.8 Flash | Pictures and audio | OpenRouter, then Google |
| **API keys** | An OpenRouter key | GPT-6 Luna | Text | OpenRouter, then OpenAI |
| **API keys** | An OpenRouter key | Scribe v2, ElevenLabs' speech model | Audio | OpenRouter, then ElevenLabs |
| **API keys** | Your Cloudflare account | Gemini 3.8 Flash, or the models you set | Pictures and text | Cloudflare, then Google |
| **API keys** | Your Cloudflare account | GPT-6 Luna, or the models you set | Text | Cloudflare, then OpenAI |
| **API keys** | **Custom server** | The model you name | What you pick | The computer at its address |
| **On this Mac** | A model on your Mac | Qwen 3.5, Parakeet, Nemotron Speech | See [Use a model on your Mac](#use-a-model-on-your-mac) | Nobody: it stays on your Mac |

OpenRouter is a service that sells access to many AI models, paid as you go. Another computer that
runs models for Lifestream has its own part, **On** *its name*.
[What leaves your Mac](./what-leaves-your-mac.md) names every receiver and what each one gets.

Chat uses a plan or a key: no model on your Mac answers in Chat.

## Connect a ChatGPT or Claude plan

1. Open **Settings** › **AI models**. If Chat shows **Sign in with ChatGPT…**,
   **Sign in with Claude…** or **Connect a model…**, you can click that instead.
2. Under **Subscriptions**, click **Connect** beside **ChatGPT** or **Claude**. If the button
   says **Sign in**, click that. Lifestream first downloads the program the plan needs: Codex for
   ChatGPT, Claude Code for Claude. Its progress shows beside the plan.
3. Click **Open sign-in page**. Your browser opens OpenAI's or Anthropic's sign-in page.
4. Sign in:
   - For ChatGPT, type the code shown under **Your code** on OpenAI's page.
   - For Claude, approve on Anthropic's page. If it shows a code, paste it into
     **Code from Anthropic**, and press Return.

When it worked, the plan's line shows your account. During setup, **Connect your AI** takes
the same steps.

## Use an OpenRouter key

1. Make a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open **Settings** › **AI models**, and find **OpenRouter** under **API keys**.
3. Paste the key into **OpenRouter key**, and click **Save**.

The line then says **Connected**. Lifestream keeps the key locked in your vault.

## Use your Cloudflare credits

Cloudflare's AI Gateway sells access to models from OpenAI, Anthropic, Google and others, paid from
the credits you buy in your Cloudflare account. Workers AI models, which Cloudflare runs itself,
are paid from the same credits once Workers AI billing is set to **Unified billing**.

1. In your Cloudflare dashboard, buy credits under **AI** › **AI Gateway**, and copy your account
   ID.
2. Make an API token that can run AI Gateway and Workers AI.
3. Open **Settings** › **AI models**, find **Cloudflare** under **API keys**, and click
   **Add account**.
4. Paste the account ID and the token, and click **Save**.

The line then says **Connected**. Lifestream keeps the account ID and token locked in your vault.
Connectors' work goes to Gemini 3.8 Flash for pictures and GPT-6 Luna for text, and Chat lists the
gateway's models under **Cloudflare**. Lifestream asks Cloudflare not to keep what it sends in the
gateway's logs and not to cache it. Cloudflare still logs each call's model, size and cost.

To have connectors use other models, name them with the command line, each as its provider and
model:

```sh
lifestream settings set model.transports.cloudflare '{"models":[{"model":"anthropic/claude-haiku-5-5","name":"Claude Haiku 5.5","kinds":["pictures","text"]}]}'
```

## Use a model on your Mac

Models on the Mac need a Mac with Apple silicon. On a Mac with an Intel processor, **On this Mac**
lists only Parakeet and Nemotron Speech.

1. Open **Settings** › **AI models**.
2. Under **On this Mac**, find the model you want.
3. Click **Download**.

The line under the model shows how far it is, such as "Downloading, 1.2 of 4.2 GB". Click
**Cancel** to stop it. When the model is ready, its button says **Remove**.

| Model | What it does | Size | Recommended from |
|---|---|---|---|
| Qwen 3.5 | Describes photos and sums up text | 4.2 GB | 16 GB of memory |
| Parakeet | Transcribes voice notes in English | 0.7 GB | 8 GB of memory |
| Nemotron Speech | Transcribes voice notes in English, Hindi and 26 more languages | 0.8 GB | 8 GB of memory |
| EmbeddingGemma 2 | Reads your screen's text for meaning, for **Search by meaning** | 0.5 GB | 8 GB of memory |

EmbeddingGemma 2 does no connector work, and no model menu lists it. Turning on **Search by
meaning** downloads it: [Settings](./settings.md#search-by-meaning) says how.

When your Mac lacks the memory for some models, the ones it can run say **Recommended for this Mac**.

While your Mac runs on battery, a model on it works only on today's and yesterday's items. The rest
waits until your Mac is plugged in, and the connector says so, such as "1,200 photos wait until
MacBook Pro is plugged in". This is **Save battery**, under your Mac's models, on unless you turn it
off. Turn it off to run everything on battery.

To stop your Mac running its models for a while, turn off **Run models** under them. Their work
waits until you turn it on again.

## Use a model at your own address

The address must take requests the way OpenAI's chat API does, as Ollama's does.

1. Open **Settings** › **AI models**, and click **Add server** beside **Custom server** under
   **API keys**.
2. In **Address**, type the address, such as `http://127.0.0.1:11434/v1`.
3. In **Model**, type the model's name, such as `qwen3.5:4b`.
4. In **Takes**, pick what the model can read: **Pictures and text**, **Text** or **Pictures**.
5. Click **Save**.

**Custom server** then shows the model and its address. Click **Remove** to stop using it.

## Pick a default model

Under **Defaults**, each menu picks the model for one kind of work. Every connector setting at
**Default** uses it.

| Default | The connector settings it serves |
|---|---|
| **Pictures** | **Photo descriptions** |
| **Audio** | **Voice note transcripts** |
| **Text** | **Email summaries**, **Chat summaries**, **Screen summaries** |

**Pictures** and **Audio** are **Off** until you pick a model; pick **Off** to turn one off again.
**Text** is the first model that is ready for text, and it stays that model until you change it.
Until then, it says **No model yet**.

The voice notes you send in Chat do not use the **Audio** default. Parakeet writes them out on a
Mac that has it. With no Parakeet, they go to Scribe v2 through your OpenRouter key, as they are:
Lifestream cannot hide personal details in a voice.

## Pick a model for one connector

Open **Connectors**, then the connector. Under **AI**, click a job, such as **Email summaries**. Its
**Model** is **Off**, **Default** or a model you name. [Connectors](./connectors/README.md#settings-every-connector-has)
says how these settings and **Read back to** work.

A model that sends what it reads away gets each item with its personal details hidden, unless you
change that, as [What leaves your Mac](./what-leaves-your-mac.md#what-is-hidden-before-sending)
says. **Screen summaries** need a model that takes a whole sitting's text: Qwen 3.5, the model
Lifestream downloads for you, is too small for it. [Screen](./connectors/screen.md#what-a-model-reads)
says what a screen summary sends.

## Keep your data on your Mac

In every model menu, each model that is ready has a note. **Stays on** means the model runs on
your computer: a model under **On this Mac**, or a custom server on this Mac. **Sent to** names who
gets what the model reads, such as OpenAI. To keep a connector's items on your Mac, give each of
its jobs a model that says **Stays on**, or set it to **Off**. Chat always sends to a company.

## Turn models off

- To stop one job of one connector, click it under the connector's **AI**, and set **Model** to
  **Off**.
- To stop using a plan, click **Sign out** beside it under **Subscriptions**. To stop using a key
  or a custom server, click **Remove**.
- To stop the models on your Mac, turn off **Run models** under them, or click **Remove** beside
  each one.

A setting or default that names a model you signed out of or removed keeps it. Its work waits
until the model is back, or until you pick another one. Lifestream never moves it to another model
by itself.

## Next

- [Connectors](./connectors/README.md#settings-every-connector-has), to set what a model does with a connector.
- [Settings](./settings.md), for every setting in **Settings**.
