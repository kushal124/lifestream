# Claude Code

The Claude Code connector brings your Claude Code sessions into Lifestream. Lifestream reads the
sessions Claude Code keeps on your Mac every 5 minutes, and brings in the ones it already keeps.

## What it brings in

- Every line of each session you start in Terminal or in the Claude desktop app: your prompts,
  Claude's replies, the tools it used and what they returned.
- The sessions of the sub-agents that Claude Code starts.
- The long outputs that Claude Code saves beside a session.

It does not bring in a session that a program starts, such as `claude -p` or the Agent SDK. So the
work Lifestream does with your Claude plan never comes in here. It does not bring in Claude Code's
memory notes.

Lifestream reads a session while you work in it. Sessions from the last hour come in first, then
the older ones. By default, Claude Code deletes a session 30 days after it was last used, so your
past goes back only as far as Claude Code keeps it.

## Before you start

- Lifestream on your Mac.
- Claude Code on the same Mac.

## Add Claude Code

Lifestream finds Claude Code by its sessions folder, `~/.claude/projects`. If the folder is on your
Mac, Claude Code appears under **Mac Sources** when you set up Lifestream. If you kept it ticked
there, it is already connected and needs no permission.

If you disconnected it, open **Claude Code** on **Connectors** and click **Connect**.

## Where it shows up

- **Timeline** shows each session as "Claude Code in" and the folder you worked in, such as
  "Claude Code in project". It counts your turns, the tool calls and the sub-agents, names up to 5
  files that were changed, and quotes what you typed, up to 1,000 characters for each prompt.
- **Search** finds a session by the words you typed or the words Claude wrote.
- **Chat** reads your sessions when a question needs them.

## What a model reads

No AI model reads Claude Code, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Claude Code has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new sessions **Every 5 minutes**, and brings in your past from Lifestream's start.

## Limits

- Lifestream reads only `~/.claude/projects` in your home folder. If you told Claude Code to keep
  its files in another folder, Lifestream does not find them.
- A session that Claude Code has deleted cannot come in.

## Problems and fixes

These are the messages only Claude Code shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**A session log couldn't be read**\
Lifestream read far into a file in the folder and found no line that starts a session. The rest
of your sessions still come in. The message stays while the file is there.
