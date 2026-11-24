# ChatGPT

The ChatGPT connector brings your conversations with ChatGPT into Lifestream. The Chrome extension
reads them in your own Chrome, where you are signed in to ChatGPT, every 30 minutes. You can also
hand in the export that ChatGPT makes of your data. This connector holds what you said to ChatGPT, not
the work Chat or Lifestream sends to a model.

## What it brings in

- Every conversation, with its title: those in your list, your archived conversations, and those
  in your projects.
- Every message in each conversation, yours and ChatGPT's, with the steps ChatGPT took, such as a
  search or running code.
- The files in each conversation: the files you uploaded and the images in it.

If a conversation comes both through Chrome and in an export, Lifestream shows each message once.

Your past comes in batches of 10 conversations, one batch every 2 minutes, newest first. Lifestream
reads about one conversation every 5 seconds, because ChatGPT limits requests that come faster.

## Before you start

- Lifestream on your Mac.
- The Chrome extension, added and connected to Lifestream. See
  [Add the Chrome extension](../chrome-extension.md).
- Chrome signed in to ChatGPT at chatgpt.com.

## Add ChatGPT

1. Open **Connectors**, then **ChatGPT**.
2. Under **To connect**, click **Connect**.

Lifestream reads ChatGPT at once, and then every 30 minutes. You can also turn ChatGPT on from the
extension, as [Connect the sites it reads](../chrome-extension.md#connect-the-sites-it-reads) says.

To hand in ChatGPT's export instead, or as well, open **ChatGPT export** under **Imports** on
**Connectors**, as [Bring in your past from an export](../imports.md) says.

## Where it shows up

- **Timeline** shows each conversation under its title, such as "ChatGPT · Trip packing list", with
  your messages and ChatGPT's replies. Open a conversation and click **Open in ChatGPT** to see it
  at chatgpt.com.
- **Search** finds a message by the words you or ChatGPT wrote, and a conversation by its title. It
  does not search the text of the files you attached.
- **Chat** reads your conversations when a question needs them.

## What a model reads

A model writes **Chat summaries**, so that very long messages stay easy to read on Timeline. For a
message you wrote of 4,000 characters or more, the model keeps the words you typed exactly, and
writes one line on what you pasted and one line for each file you attached. For a reply from
ChatGPT of 500 characters or more, it writes one line on what ChatGPT gave. Shorter messages show as
written.

- **Sends:** that one message, and for a message you wrote, the text of the files you attached. The
  same text goes once, even if it comes again in another conversation.
- **Never sends:** the conversation's title, its other messages or your account.
- **Hidden first:** the personal details in the message, as
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says.
- **By default:** the **Default** model, for your conversations from 30 days before you added
  ChatGPT. If that model is your ChatGPT or Claude plan, your messages go to OpenAI or Anthropic.
- **To stop it:** set **Chat summaries** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

ChatGPT has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new conversations **Every 30 minutes**, and brings in your past from Lifestream's
start, a batch **Every 2 min**.

## Limits

- Lifestream reads ChatGPT only while Chrome is open on your Mac.
- ChatGPT's list of conversations in Chrome is not always complete, so a conversation can be
  missed. Import ChatGPT's export to bring in what Chrome missed.
- A file larger than 32 MB is not brought in, and nor is a file ChatGPT no longer has. The rest of
  the conversation is.
- If ChatGPT asks Lifestream to slow down, Lifestream waits 30 minutes before it reads again.
- Lifestream reads the ChatGPT account that Chrome is signed in to. If Chrome signs in to another
  account, Lifestream asks before it reads that one too.

## Problems and fixes

These are the messages only ChatGPT shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show). For the lines about Chrome, such as
**Sign in to ChatGPT in Chrome** or **Another ChatGPT account**, see [the Chrome
extension](../chrome-extension.md#when-it-stops).

**ChatGPT allows more at** *a time*\
ChatGPT asked Lifestream to slow down. Lifestream goes on by itself at the time shown.

**Confirm it's you**\
ChatGPT wants you to prove it is you, such as with a code or a check. Click **Open**, and finish the
check in Chrome.
