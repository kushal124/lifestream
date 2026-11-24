# GitHub

The GitHub connector brings your own work on GitHub into Lifestream: your commits, pull requests,
issues, reviews and comments. Lifestream signs in to GitHub with an access token, checks for new
work every 5 minutes, and brings in your past.

## What it brings in

In every repository your token can see:

- Each commit that GitHub links to your account as its author, on every branch.
- Each pull request and issue you opened.
- Each review you wrote, and each comment you wrote on an issue or a pull request.

It does not bring in an issue or pull request that is only assigned to you, or a commit whose
author email is not linked to your GitHub account. It does not bring in commit comments,
discussions, gists, stars or releases.

Lifestream reads your past before anything new. Each read makes at most 400 requests to GitHub,
and the next read goes on at once.

## Before you start

- Lifestream on your Mac. GitHub is added from the Mac app.
- A fine-grained access token. On GitHub, open **Settings**, then **Developer settings**, and make
  a fine-grained token that reads **Contents**, **Issues**, **Pull requests** and **Metadata**.
  Lifestream reads only the repositories you give the token.

## Add GitHub

1. Open **Connectors**, then **GitHub**.
2. Click **Set up**. If you have not made your vault yet, Lifestream asks you to make it first
   and gives you a recovery key. Save the key somewhere safe.
3. Type your **GitHub username**, the name you sign in to GitHub with, and your **Token**.
   Click **Connect GitHub**.

Lifestream tests the token with GitHub before it saves it. When the test passes, the button reads
**Connected**, and your past starts to arrive.

## Where it shows up

Timeline and Search do not show your GitHub work. **Chat** can read it when a question needs it.

## What a model reads

No AI model reads GitHub, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

GitHub has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new work **Every 5 minutes**, and brings in your past from Lifestream's start. It has no
**Catch up every**.

## Limits

- GitHub allows each account a set number of requests an hour, shared by every app that uses the
  account. Lifestream stops when 500 or fewer are left, and goes on when GitHub allows more.
- If GitHub refuses a repository, such as one of an organisation that needs its own sign-in,
  Lifestream skips it and asks again at the next read.
- GitHub does not say what was deleted. An issue or a comment you delete on GitHub, and the
  commits of a branch you delete, stay in Lifestream.

## Problems and fixes

These are the messages only GitHub shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**GitHub refused this token. Check it reads Contents, Issues and Pull requests, then paste it again.**\
Lifestream shows this while you sign in. Check the token, or make a new one, and try again.

**That token is person-b's, not person-a's.**\
The token belongs to another GitHub account than the login you typed. Check the login, or make the
token while you are signed in to your own account.

**GitHub did not answer. Try again in a moment.**\
Your Mac could not reach GitHub while you signed in. Nothing was saved. Check your internet, then
try again.

**Sign in to GitHub again**\
GitHub refused the token. It was deleted, or it expired. Make a new token. Click **Sign in**, paste
the new token, and click **Save**.

**GitHub allows more at** *a time*\
Your account's requests for this hour are nearly used. Lifestream goes on by itself at the time
shown.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) GitHub as you would any
connector. To also take away Lifestream's access to your GitHub account, delete its token on GitHub,
under **Settings**, then **Developer settings**.
