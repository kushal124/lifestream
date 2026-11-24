# Connect ChatGPT

Connect ChatGPT once, and it can answer questions about your life in any chat. Lifestream walks you
through it, and you choose what ChatGPT reads before it reads anything.

## Before you start

- ChatGPT on the web, on a Pro, Business, Enterprise or Edu plan. In a work workspace, an admin may
  need to add Lifestream for you, as
  [OpenAI's guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
  says.
- Lifestream on your Mac.

## Open the guide

1. In Lifestream on your Mac, click **Agents** in the sidebar.
2. Click **ChatGPT**. If you see your connected agents instead, click **Connect an agent** first.

The guide ticks each step when it is done. Keep it open beside ChatGPT.
If your Mac is not set up yet for agents on the internet, the guide starts with **Set up
Tailscale**: do it first, as [Connect an agent](./connect-an-agent.md#set-up-tailscale) says.

On your iPhone, the **Agents** tab has the same guide. Add Lifestream to ChatGPT on a computer, and say yes on your
iPhone.

## Add Lifestream to ChatGPT

1. In the guide, click **Open ChatGPT**.
2. In the ChatGPT sidebar, open **Plugins**.
3. Click **Add** (the plus button), then **Add custom MCP server**.
4. In **Name**, type `Lifestream`.
5. In the guide, click **Copy** beside **Server URL**. In ChatGPT, paste it into **Server URL**.
6. Leave **Authentication** on **OAuth**, and the rest as it is.
7. Tick **I understand and want to continue**, then click **Create as a plugin**.
8. Click **Install**, or **Continue to Lifestream** if ChatGPT shows it.

ChatGPT opens Lifestream's sign-in page. It says "ChatGPT wants to read your Lifestream.", then
"From chatgpt.com", and shows a number.

## Say yes in Lifestream

The guide's second step now says "ChatGPT wants to read your Lifestream". It shows what ChatGPT
will see, and three numbers.

1. To change what ChatGPT will see, click **Edit**, change it, and click **Done**.
2. Click the number that ChatGPT's sign-in page shows. Picking the number is your yes.

The sign-in page says "Approved." and takes you back to ChatGPT. The guide says "ChatGPT is
connected".

If you closed the guide, your Mac shows a notification: "ChatGPT wants to read your Lifestream.
Pick the number it shows." Click it, and the guide opens at **Say yes here**. On your iPhone, the sign-in
waits under **Needs you** on the **Agents** tab.

## Ask it a first question

1. In ChatGPT, start a new chat.
2. Type `@`, and select **Lifestream**.
3. Send the question the guide shows under **Ask it first**:

   ```
   Use Lifestream to tell me what I did yesterday.
   ```

ChatGPT answers from Lifestream. In Lifestream, **Agents** › **ChatGPT** › **History** shows what it
read.

## If something goes wrong

- **ChatGPT says the name already exists.** Open **Lifestream** under **Installed**, then
  **Settings**, and click **Reconnect** under **Connected accounts**.
- **Your ChatGPT sidebar shows Apps, not Plugins.** Follow
  [OpenAI's guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
  for **Apps** and developer mode, with the same address.
- **ChatGPT shows no Lifestream tools.** Reconnect as above, then start a new chat.

## Next

- [Choose what ChatGPT reads](./choose-what-an-agent-reads.md)
