# Connect Grok Bot

Connect the Grok Bot desktop app once, and it can answer questions about your life. Lifestream
walks you through it: you choose what Grok Bot reads, then you copy four values into
Grok Bot. [Grok Bot's guide](https://docs.x.ai/grok-bot/computer-and-apps#connect-an-app) says
more about its connectors.

## Before you start

- The Grok Bot desktop app.
- Lifestream on your Mac. You connect Grok Bot on the Mac, not on your iPhone.

## Open the guide

1. In Lifestream on your Mac, click **Agents** in the sidebar.
2. Click **Grok Bot**. If you see your connected agents instead, click **Connect an agent** first.

The guide ticks each step when it is done.
If your Mac is not set up yet for agents on the internet, the guide starts with **Set up
Tailscale**: do it first, as [Connect an agent](./connect-an-agent.md#set-up-tailscale) says.

## Choose what Grok Bot sees

Under **It will see**, the guide shows what Grok Bot will read.

1. To change it, click **Edit**, change it, and click **Done**.
2. Click **Make the key**.

The guide then shows four values, each with **Copy**. Lifestream shows the key only now, so keep
the guide open until Grok Bot has all four.

## Add Lifestream to Grok Bot

1. In Grok Bot, open **Connect apps**, and choose **Add a custom connector** at the bottom.
2. In **Name**, type `Lifestream`. In **Type**, select **Remote HTTPS**.
3. In the guide, click **Copy** beside **Server URL**. In Grok Bot, paste it into **Server URL**.
4. Add an HTTP header. In its name, type `Authorization`.
5. In the guide, click **Copy** beside **Header value**. In Grok Bot, paste it into the header's
   value. It starts with `Bearer`.
6. Click **Add plugin**.
7. In the guide, click **Done**.

The guide says "Grok Bot is connected". If Grok Bot says a policy blocks the connector, ask your
workspace admin.

If you closed the guide before you copied the key, the key is lost. Click **Grok Bot** under
**Connected**, and disconnect it. Then connect it again from the start.

## Ask it a first question

In a Grok Bot chat, send the question the guide shows under **Ask it first**:

```
Use Lifestream to tell me what I did yesterday.
```

Grok Bot answers from Lifestream. In Lifestream, **Agents** › **Grok Bot** › **History** shows what
it read.

## Next

- [Choose what Grok Bot reads](./choose-what-an-agent-reads.md)
