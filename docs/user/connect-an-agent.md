# Connect an agent

Let an agent, an AI app such as Claude, ChatGPT or Muse, read Lifestream to help you. Lifestream has
a guide for each app that walks you through every step. An agent reads only what you allow it, and
it cannot change your data. [Choose what an agent reads](./choose-what-an-agent-reads.md) says how
to choose.

## Before you start

- Lifestream on your Mac.

## Open Agents

Click **Agents** in the sidebar, below **Connectors**. On your iPhone, tap the **Agents** tab.

Before any agent is connected, the page lists the apps you can connect. After that, it lists the
agents that wait for you under **Needs you**, every agent that can read Lifestream under
**Connected**, Chat under **In Lifestream**, and the agents you disconnected under
**Disconnected**. Each shows a summary of what it reads and when it last read. To connect one more,
click **Connect an agent**.

## Connect an app

1. Click the app in the list.
2. Follow the steps in the guide that opens. The guide ticks each step when it is done.

Each app also has a page with the clicks to make in the app itself:

- [Connect Claude](./connect-claude.md)
- [Connect ChatGPT](./connect-chatgpt.md)
- [Connect Muse](./connect-muse.md)
- [Connect Grok Bot](./connect-grok-bot.md)
- [Connect Instinct](./connect-instinct.md)
- For any other app that takes an address and a key, such as Claude Code, click **Another agent**,
  as [Connect another agent](#connect-another-agent) says.

On your iPhone, the **Agents** tab has the same guides. The iPhone guides Instinct from start to
finish. For Claude, ChatGPT and Muse, it copies or shares the address for you, and you say yes on
the iPhone. You connect Grok Bot and other agents on your Mac.

## Set up Tailscale

Claude, ChatGPT, Muse, Grok Bot and Instinct reach Lifestream from the internet, through Tailscale,
a free app that gives your Mac an address there. Until it is ready, the guide starts with **Set up
Tailscale**, and the other steps wait under it. Its button is the next thing to do:

| The step says | Do this |
|---|---|
| "Your address needs Tailscale on this Mac." | Click **Get Tailscale**, install it, and open it. |
| "Open Tailscale to get your address." | Click **Open Tailscale**. |
| "Sign in to Tailscale to get your address." | Click **Sign in**, and sign in to Tailscale. |
| "Allow Funnel in Tailscale to put your address on the internet." | Click **Allow Funnel**, and allow it on the page that opens. Then come back to the guide. |
| "Tailscale is ready. Turn on Lifestream's agent address." | Click **Turn on**. |
| "Tailscale already serves something else at this address." | Another app uses this Mac's address in Tailscale, and Lifestream does not replace it. Remove it in Tailscale, then click **Check again**. |
| "Tailscale did not answer. Open Tailscale on your Mac." | Open Tailscale, then click **Check again**. |

The step is ticked when your address is on the internet, and the guide goes on. On your iPhone, the
step says what to do on your Mac. **Another agent** on your Mac needs no Tailscale.

## Your internet address

When you copy an address in a guide, Lifestream puts its agent address on the internet. The guide
then says "Lifestream's agent address is now on the internet. Only agents you say yes to can read."
Making a key for Grok Bot or Instinct puts it there too.

The address stays on until you disconnect the last app that reads from the internet: then
Lifestream turns it off by itself. Agents on your Mac, such as Claude Code, don't need it.

## Approve a sign-in

Claude, ChatGPT and Muse sign in on Lifestream's sign-in page. The page names the app, such as
"Claude wants to read your Lifestream.", and under it where the access goes, such as "From
claude.ai". If the line starts with "says it is", Lifestream could not check the app's name. Make
sure the address after it is the app you meant.

You say yes on your Mac or your iPhone. Lifestream shows "Claude wants to read your Lifestream",
what Claude will see under **It will see**, and three numbers. Click the number the sign-in page
shows: picking it is your yes. To change what the agent will see first, click **Edit**, as
[Choose what an agent reads](./choose-what-an-agent-reads.md#choose-when-an-agent-connects) says.

- **On your Mac,** the request shows in the guide's second step, and under **Needs you** on the
  Agents page. If the Lifestream window is not in front, a notification says "Claude wants to read
  your Lifestream. Pick the number it shows." Click it.
- **On your iPhone,** open Lifestream. The iPhone app shows requests only while it is open.
  Lifestream asks for Face ID or your passcode before it sends your yes.

If you did not start the sign-in, click **Don't allow**. A wrong number also ends the sign-in, and
the sign-in page says "Another number was tapped. Start connecting again." A request waits 10
minutes. After that, the sign-in page says "This sign-in ended." Connect again from the app.

## Connect another agent

Use **Another agent** for an app that takes an address and a key, such as Claude Code, Cursor or a
script. You connect it on your Mac.

1. On the **Agents** page, click **Another agent**.
2. Type a name for the app, such as `Claude Code`.
3. Under **It will see**, check what the app will read. To change it, click **Edit**.
4. Click **Make the key**.
5. Copy what the app needs. Lifestream shows the key only now.
   - **Claude Code** is a command. Run it in Terminal on this Mac, and paste the **Key** when it
     asks for your Lifestream pass.
   - **Address** and **Key** are for any other app on this Mac. The app sends the **Key** with each
     request as a Bearer token.
   - **From the internet** is the address for an app on another computer or on the internet. It
     shows once Tailscale is set up on this Mac. Copying it lets this key read from the internet.
6. Click **Done**.

An app on another of your devices on Tailscale can also use the **Key**, with your Mac's Tailscale
name in place of `127.0.0.1` in the **Address**. Do not use the **Key** over your Wi-Fi: there, the
**Key** and everything the agent reads travel unencrypted.

This access never expires. The app can read Lifestream until you disconnect it.

## What an agent can do

An agent reads Lifestream with six tools. It cannot change your data: it can only save notes for
you, and ask you to let it read more. [The tools an agent gets](./agent-tools.md) says what each tool
answers, and what an agent can and cannot do. Everything an agent reads goes to that app, and to
the company that runs it, as [What leaves your Mac](./what-leaves-your-mac.md#what-an-agent-reads)
says.

## See and disconnect an agent

1. On the Agents page, click the agent. Its page shows what it reads, its last reads and how it
   connected.
2. At the foot of its page, click the **Disconnect** button that carries its name, such as
   **Disconnect Claude…**.
3. The page lists what **Stops** and what **Stays**. Click **Disconnect Claude**.

The agent cannot read Lifestream from then on. It stays under **Disconnected**, with its history,
and nothing is deleted. To take it off the list, click it, then **Remove from the list…**, then
**Remove**. Its history stays in Lifestream. To let it read again, connect it again. What the agent
already read stays with it: ask its maker to delete it.

## Next

- [Choose what an agent reads](./choose-what-an-agent-reads.md), to limit what an agent reads.
- [Chat with your life](./chat.md), to ask your own questions in Lifestream.
- [How Lifestream keeps your data safe](./keep-your-data-safe.md#what-listens-on-your-network), to see what listens on your network.
