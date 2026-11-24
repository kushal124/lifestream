# Connect Instinct

Connect Instinct once, and you can text it questions about your life in Messages. Lifestream walks
you through it on your Mac or your iPhone, and you choose what Instinct reads before
it reads anything. [Instinct](https://instinct.com/)

## Before you start

- Instinct in Messages.
- Lifestream on your Mac. The guide also runs whole on your iPhone.

## Open the guide

1. In Lifestream, open **Agents**: in the sidebar on your Mac, or the tab on your iPhone.
2. Click **Instinct**. If you see your connected agents instead, click **Connect an agent** first.

The guide ticks each step when it is done.
If your Mac is not set up yet for agents on the internet, the guide starts with **Set up
Tailscale**: do it first, as [Connect an agent](./connect-an-agent.md#set-up-tailscale) says.

## Ask Instinct for a secure link

1. In the guide, click **Copy** beside **Message**, then **Open Messages**.
2. Paste the message to Instinct, and send it.
3. Wait for Instinct's reply with a secure link.
4. In the guide, click **I have the link**.

If Instinct cannot send a link, ask it how it sets up a remote MCP server for your account.

## Choose what Instinct sees

Under **It will see**, the guide shows what Instinct will read.

1. To change it, click **Edit**, change it, and click **Done**.
2. Click **Make the key**.

The guide then shows the **Address** and the **Key**, each with **Copy**. Lifestream shows the key
only now, so keep the guide open until both are in the secure link.

## Paste them into the secure link

> [!WARNING]
> Paste the key only into the secure link, never into Messages. Anyone who sees the key can read
> what you allow Instinct to read.

1. Open the secure link from Instinct.
2. In the guide, click **Copy** beside **Address**. Paste it into the link's address field.
3. In the guide, click **Copy** beside **Key**. Paste it into the link's key field.
4. In the guide, click **Done**.

The guide says "Instinct is connected".

If you closed the guide before you copied the key, the key is lost. Open **Instinct** under
**Connected**, and disconnect it. Then connect it again from the start.

## Ask it a first question

Text Instinct the question the guide shows under **Ask it first**:

```
Use Lifestream to tell me what I did yesterday.
```

Instinct answers from Lifestream. In Lifestream, **Agents** › **Instinct** › **History** shows what
it read.

## Next

- [Choose what Instinct reads](./choose-what-an-agent-reads.md)
