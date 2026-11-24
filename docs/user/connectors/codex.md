# Codex

The Codex connector brings your Codex sessions into Lifestream. Lifestream reads the sessions Codex
keeps on your Mac every 5 minutes, and brings in the ones it already keeps, archived ones too.

## What it brings in

- Every line of each session you start: your prompts, Codex's replies, the tools it used and what
  they returned.
- The sessions of the sub-agents that Codex starts.
- Your archived sessions.

It does not bring in a session that a program starts with `codex exec`, or one that a Codex
automation starts. So the work Lifestream does with your ChatGPT plan never comes in here.

Lifestream reads a session while you work in it. Sessions from the last hour come in first, then
the older ones.

## Before you start

- Lifestream on your Mac.
- Codex on the same Mac.

## Add Codex

Lifestream finds Codex by its sessions folders, `~/.codex/sessions` and
`~/.codex/archived_sessions`. If either folder is on your Mac, Codex appears under **Mac Sources**
when you set up Lifestream. If you kept it ticked there, it is already connected and needs no
permission.

If you disconnected it, open **Codex** on **Connectors** and click **Connect**.

## Where it shows up

- **Timeline** shows each session as "Codex in" and the folder you worked in, such as "Codex in
  project". It counts your turns, the tool calls and the sub-agents, names up to 5 files that were
  changed, and quotes what you typed, up to 1,000 characters for each prompt.
- **Search** finds a session by the words you typed or the words Codex wrote.
- **Chat** reads your sessions when a question needs them.

## What a model reads

No AI model reads Codex, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Codex has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new sessions **Every 5 minutes**, and brings in your past from Lifestream's start.

## Limits

- Lifestream reads only the `.codex` folder in your home folder. If you told Codex to keep its
  files in another folder, Lifestream does not find them.

## Problems and fixes

These are the messages only Codex shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**A session log couldn't be read**\
Lifestream read far into a file in the folder and found no line that starts a session. The rest
of your sessions still come in. The message stays while the file is there.
