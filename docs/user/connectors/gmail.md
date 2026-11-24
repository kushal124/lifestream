# Gmail

The Gmail connector brings every email you send and receive into Lifestream. Lifestream signs in to
Gmail with an app password, checks for new mail every 5 minutes, and brings in your past, newest
first.

## What it brings in

- Every message in your All Mail: the mail you receive, send and archive, and your drafts.
- The whole of each message, as Gmail keeps it: its headers, its text, its attachments and its
  labels.

It does not bring in your Spam or your Trash unless you turn them on. It does not bring in
whether you have read a message.

Your past comes in batches of up to 500 emails, one batch a minute. Lifestream downloads at most
2 GB of your past each day, so that Google's daily limit always leaves room for new mail. A
large mailbox can take several days to come in.

## Before you start

- Lifestream on your Mac. Gmail is added from the Mac app.
- 2-Step Verification turned on for your Google account.
- An app password for Lifestream. An app password is a password Google makes for one app, so the
  app never needs your real password. Make one at
  [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
- All Mail shown to IMAP, the way mail apps read Gmail. It is shown unless you changed it. To
  check, open Gmail's settings, go to **Labels**, and make sure **Show in IMAP** is ticked beside
  **All Mail**.

## Add Gmail

1. Open **Connectors**, then **Gmail**.
2. Click **Set up**. If you have not made your vault yet, Lifestream asks you to make it first
   and gives you a recovery key. Save the key somewhere safe.
3. Type your **Gmail address** and your **App password**, and click **Connect Gmail**.

Lifestream tests the password with Gmail before it saves it. When the test passes, the button
reads **Connected**. New mail arrives from then on, and your past follows.

## Where it shows up

- **Timeline** shows each email you send as "Sent" and its subject. Emails you receive are
  grouped by hour, such as "3 mails", with who sent them.
- **Search** finds an email by its subject, its text, or the address of anyone it was from or to.
- **People** joins the people you email with the same people in your messages and contacts.
- **Chat** reads your emails when a question needs them.

## What a model reads

A model writes **Email summaries**: one line for each automated email, such as a receipt or a
newsletter, so Timeline can say what it was about.

- **Sends:** every email, not only the automated ones, so the model can tell the two apart. Of each
  email, the sender, the recipients, the subject and the first 4,000 characters of the text.
- **Never sends:** spam, trash, drafts or Google Chat messages.
- **Hidden first:** the personal details in each email, as
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says.
- **By default:** the **Default** model, for your mail from 30 days before you added Gmail. If that
  model is your ChatGPT or Claude plan, your emails go to OpenAI or Anthropic.
- **To stop it:** set **Email summaries** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Gmail has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new mail **Every 5 minutes**, and brings in your past from Lifestream's start, a batch
**Every minute**.

It has two settings of its own, both off unless you turn them on. **Include Spam** brings in the
email in your Spam, and **Include Trash** the email in your Trash, from the moment you turn it on.

## Limits

- Lifestream reads one Gmail account. If you sign in with a different address, it reads the new
  account from that moment on.
- A Google Takeout brings in your Spam and your Trash as they were when you asked for it, whatever
  these settings say.
- If Gmail asks Lifestream to slow down, Lifestream waits an hour before it reads again.
- Google offers no app password for some accounts, such as an account in Advanced Protection, an
  account whose 2-Step Verification uses only security keys, and many work and school accounts.
  Lifestream cannot read Gmail for these accounts. A
  [Google Takeout](../imports.md) can bring in their mail instead.

## Problems and fixes

These are the messages only Gmail shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Sign in to Gmail again**\
Gmail refused the app password. It was removed, it was changed, or 2-Step Verification was turned
off. Make a new app password. Click **Sign in**, paste the new password, and click **Save**.

**Google refused this password. Make a new app password and paste it here.**\
Lifestream shows this while you sign in. Check the address, make a new app password, and try
again.

**Gmail did not answer**\
Your Mac could not reach Gmail while you signed in. Nothing was saved. Check your internet, then
sign in again.

**Couldn’t read Gmail**\
The usual cause is that All Mail is hidden from IMAP. Show it (see
[Before you start](#before-you-start)), then click **Try now**.

**Gmail allows more at** *a time*\
Lifestream has used the day's download allowance, or Gmail asked it to wait. It goes on by itself
at the time shown.

## Remove Lifestream's access

Your app password is locked in your vault. Lifestream uses it only to sign in to Gmail.

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Gmail as you would any connector.
To also take away Lifestream's access to your Google account, remove its app password at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).

### Erase your emails

Disconnecting Gmail keeps the emails that are already in Lifestream. You can erase them with the
`lifestream` command in Terminal. Disconnect Gmail first, so that no new mail arrives after you
erase.

> [!WARNING]
> Erasing cannot be undone. Once you run it with `--apply`, the emails are gone from Lifestream.

In Terminal, run this command with your Gmail address in place of `you@example.com`. Its last
part, `gmail:you@example.com:cloud`, is how Lifestream names your Gmail account: `gmail`, your
address, and `cloud`, since the mail comes from Google's servers.

```sh
~/.local/bin/lifestream erase mail gmail:you@example.com:cloud
```

Lifestream lists what it would erase, and changes nothing. To erase, run the same command again
with `--apply` at the end. To erase the emails of every Gmail account in Lifestream, type `all` in
place of `gmail:you@example.com:cloud`.

Lifestream removes each email, its email summary, and its place in Search, People and Chat. It makes each day on Timeline that showed an email again without it. If
Gmail or a Google Takeout brings in the same emails later, Lifestream refuses them.

A Google Takeout that you brought in still holds the emails in its own file. To remove that file
too, add `--purge-deliveries` before `--apply`. This removes the whole Takeout, with everything
else in it, and Lifestream cannot read it again.
