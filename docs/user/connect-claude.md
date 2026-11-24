# Connect Claude

Connect Claude once, and it can answer questions about your life in any chat. Lifestream walks you
through it, and you choose what Claude reads before it reads anything.

## Before you start

- Claude on the web. A free account can add one custom connector. On Team or Enterprise, a
  workspace owner adds it under **Organization settings**, as
  [Claude's guide](https://claude.com/docs/connectors/custom/add-unlisted) says.
- Lifestream on your Mac.

## Open the guide

1. In Lifestream on your Mac, click **Agents** in the sidebar.
2. Click **Claude**. If you see your connected agents instead, click **Connect an agent** first.

The guide ticks each step when it is done. Keep it open beside Claude.
If your Mac is not set up yet for agents on the internet, the guide starts with **Set up
Tailscale**: do it first, as [Connect an agent](./connect-an-agent.md#set-up-tailscale) says.

On your iPhone, the **Agents** tab has the same guide. Add Lifestream to Claude on a computer, and say yes on your
iPhone.

## Add Lifestream to Claude

1. In the guide, click **Open Claude**.
2. In the Claude sidebar, open **Plugins**, then **Connectors**. Some layouts show **Customize**,
   then **Connectors**.
3. Click **Add**, then **Add custom connector**.
4. In **Name**, type `Lifestream`.
5. In the guide, click **Copy** beside **MCP server URL**. In Claude, paste it into
   **MCP server URL**.
6. Click **Continue**. If Claude offers a choice, select **Sign in now** and
   **Use Claude's published identity**.
7. Click **Add**, then **Connect**.

Claude opens Lifestream's sign-in page. It says "Claude wants to read your Lifestream.", then
"From claude.ai", and shows a number.

## Say yes in Lifestream

The guide's second step now says "Claude wants to read your Lifestream". It shows what Claude will
see, and three numbers.

1. To change what Claude will see, click **Edit**, change it, and click **Done**.
2. Click the number that Claude's sign-in page shows. Picking the number is your yes.

The sign-in page says "Approved." and takes you back to Claude. The guide says "Claude is
connected".

If you closed the guide, your Mac shows a notification: "Claude wants to read your Lifestream. Pick
the number it shows." Click it, and the guide opens at **Say yes here**. On your iPhone, the sign-in waits
under **Needs you** on the **Agents** tab.

## Ask it a first question

1. In Claude, start a new chat.
2. Click **+**, and check that **Lifestream** is on under **Connectors**.
3. Send the question the guide shows under **Ask it first**:

   ```
   Use Lifestream to tell me what I did yesterday.
   ```

Claude answers from Lifestream. In Lifestream, **Agents** › **Claude** › **History** shows what it
read.

## If something goes wrong

- **Claude says a connector with that URL already exists.** Open **Plugins** › **Connectors**, and
  click **Reconnect** on the Lifestream row.

## Next

- [Choose what Claude reads](./choose-what-an-agent-reads.md)
