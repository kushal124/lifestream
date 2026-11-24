# Claude

The Claude connector brings your conversations with Claude at claude.ai into Lifestream. The Chrome
extension reads them in your own Chrome, where you are signed in to Claude, every 30 minutes. You
can also hand in the export that Claude makes of your data. This connector holds what you said to
Claude, not the work Chat or Lifestream sends to a model.

## What it brings in

- Every conversation, with its title.
- Every message in each conversation, yours and Claude's, with the tools Claude used.
- The files you attached: their names, and the text Claude took from them.

Lifestream does not download the files themselves.

If a conversation comes both through Chrome and in an export, Lifestream shows each message once.

Your past comes in batches of 10 conversations, one batch every 2 minutes, newest first.

## Before you start

- Lifestream on your Mac.
- The Chrome extension, added and connected to Lifestream. See
  [Add the Chrome extension](../chrome-extension.md).
- Chrome signed in to Claude at claude.ai.

## Add Claude

1. Open **Connectors**, then **Claude**.
2. Under **To connect**, click **Connect**.

Lifestream reads Claude at once, and then every 30 minutes. You can also turn Claude on from the
extension, as [Connect the sites it reads](../chrome-extension.md#connect-the-sites-it-reads) says.

To hand in Claude's export instead, or as well, open **Claude export** under **Imports** on
**Connectors**, as [Bring in your past from an export](../imports.md) says.

## Where it shows up

- **Timeline** shows each conversation under its title, such as "Claude · Garden plan", with your
  messages and Claude's replies. Open a conversation and click **Open in Claude** to see it at
  claude.ai.
- **Search** finds a message by the words you or Claude wrote, and a conversation by its title. It
  does not search the text of the files you attached.
- **Chat** reads your conversations when a question needs them.

## What a model reads

A model writes **Chat summaries**, so that very long messages stay easy to read on Timeline. For a
message you wrote of 4,000 characters or more, the model keeps the words you typed exactly, and
writes one line on what you pasted and one line for each file you attached. For a reply from
Claude of 500 characters or more, it writes one line on what Claude gave. Shorter messages show as
written.

- **Sends:** that one message, and for a message you wrote, the text of the files you attached. The
  same text goes once, even if it comes again in another conversation.
- **Never sends:** the conversation's title, its other messages or your account.
- **Hidden first:** the personal details in the message, as
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says.
- **By default:** the **Default** model, for your conversations from 30 days before you added
  Claude. If that model is your ChatGPT or Claude plan, your messages go to OpenAI or Anthropic.
- **To stop it:** set **Chat summaries** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Claude has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new conversations **Every 30 minutes**, and brings in your past from Lifestream's start, a
batch **Every 2 min**.

## Limits

- Lifestream reads Claude only while Chrome is open on your Mac.
- If Claude asks Lifestream to slow down, Lifestream waits 30 minutes before it reads again.
- Lifestream reads the Claude account that Chrome is signed in to. If Chrome signs in to another
  account, Lifestream asks before it reads that one too.

## Problems and fixes

These are the messages only Claude shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show). For the lines about Chrome, such as
**Sign in to Claude in Chrome** or **Another Claude account**, see [the Chrome
extension](../chrome-extension.md#when-it-stops).

**Claude allows more at** *a time*\
Claude asked Lifestream to slow down. Lifestream goes on by itself at the time shown.

**Confirm it's you**\
Claude wants you to prove it is you, such as with a code or a check. Click **Open**, and finish the
check in Chrome.
