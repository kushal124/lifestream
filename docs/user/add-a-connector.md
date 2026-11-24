# Add a connector with your coding agent

When **Connectors** does not list the connector you want, a coding agent can write it for
you. A coding agent is an AI app that writes and runs code on your Mac, such as Claude Code or
Codex. It adds the connector to Lifestream, and you then set it up like any other connector.

## Before you start

- Lifestream set up on your Mac. The [Quick start](./quick-start.md) says how.
- A coding agent on the same Mac.

## Ask your agent

1. In Lifestream, open **Connectors**.
2. Type the name of what you want in the search field, such as **Obsidian**.
3. At the end of the list, click **Not here?**. Its line says "Your coding agent can build it on
   your Mac."
4. Click **Copy line**. The line names what you searched for:

   ```text
   Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for Obsidian; type each lifestream command it names as ~/.local/bin/lifestream.
   ```

5. Paste the line into your coding agent.

The agent reads Lifestream's guide, writes the connector, and tests it on made-up data. It then
installs the connector in Lifestream, which restarts to load it. The new connector shows on
**Connectors**. Open its window to set it up, as for any connector.

On the iPhone, tap **Not here?** at the end of **Connectors**. **Copy line** puts the line on the
clipboard your iPhone shares with your Mac. Paste it into your agent on the Mac.

You can also tell your agent "add my Obsidian notes to Lifestream" in your own words. The command
`lifestream` works in each new terminal window, and the agent finds its way from there.

## What an agent can add

An agent can add a connector that reads:

- a service with a key or a link that you paste;
- a service that you sign in to with your own account;
- a website that you are signed in to in Chrome, through the Chrome extension;
- a file that you export from a service and hand over in its window under **Imports**;
- a folder of files on your Mac;
- the data that an app keeps on your Mac.

Some connectors need a new version of Lifestream, so an agent cannot add them: a new recorder on the
iPhone or the Mac, a photo library, a new group on **Connectors**, a new permission on the Mac or the
iPhone, or an export that several connectors read, as a Google Takeout is.

## A connector you add is software you install

> [!WARNING]
> A connector you add is a program that Lifestream runs, and Lifestream does not limit what it does.
> It can read everything in Lifestream, every file your Mac account can read, and the internet. Add
> only a connector that you or your agent wrote, or one from someone you trust.

Lifestream runs only the connectors you put in it, and never downloads or updates one. Each one is
a folder in the `connectors` folder of Lifestream's folder.

## Remove a connector you added

Ask your agent to remove it, or run `~/.local/bin/lifestream connectors remove <name>` in Terminal. What the
connector brought in stays in Lifestream. It leaves your days and search after Lifestream has rebuilt
them. Lifestream keeps the connector's folder, so your agent can install it again later, with what it
brought in.

## The lifestream command

When you set up Lifestream, it puts the command `lifestream` in the folder `~/.local/bin`, without
your password. Agents run it to work with Lifestream.

If your shell does not look in `~/.local/bin` yet, Lifestream adds three lines to your shell's
startup files: `~/.zprofile` and `~/.zshrc` for zsh, the profile file for bash, or a file of its own,
`~/.config/fish/conf.d/lifestream.fish`, for fish. The lines start with `# >>> Lifestream >>>`. If
you delete them, Lifestream does not add them again. For any other shell, Lifestream changes no file:
**Command line** shows the command's full path, `~/.local/bin/lifestream`, and adding `~/.local/bin`
to your shell's PATH is yours to do.

A terminal window or an agent session that was open before keeps its old setting until you open a
new one. The copied line names `~/.local/bin/lifestream` in full and asks your agent to run it so,
which works there too, and in a shell that reads none of those files, as some agents' shells do.

**Settings** › **This Mac** › **Command line** shows the command. **Remove** takes the command away,
and the lines it added to your shell's files. **Install** puts them back. **Agent prompt** shows the
line for your agent, with a copy button beside it.

## Next

- [Connectors](./connectors/README.md), to set up the new connector.
- [Settings](./settings.md#this-mac), for the **Command line** row.
