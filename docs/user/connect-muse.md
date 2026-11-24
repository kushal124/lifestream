# Connect Muse

Ask Muse once, and it sets up Lifestream for itself. Lifestream walks you through it, and you
choose what Muse reads before it reads anything.

## Before you start

- Muse on the web, signed in at [muse.ai](https://muse.ai/).
  [Meta's guide](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/) says more.
- Lifestream on your Mac.

## Open the guide

1. In Lifestream on your Mac, click **Agents** in the sidebar.
2. Click **Muse**. If you see your connected agents instead, click **Connect an agent** first.

The guide ticks each step when it is done. Keep it open beside Muse.
If your Mac is not set up yet for agents on the internet, the guide starts with **Set up
Tailscale**: do it first, as [Connect an agent](./connect-an-agent.md#set-up-tailscale) says.

On your iPhone, the **Agents** tab has the same guide.

## Ask Muse to connect

The guide's first step holds a message for Muse, which ends with your Lifestream address.

1. In the guide, click **Copy** beside **Message**.
2. Click **Open Muse**.
3. In Muse, start a **New side chat**. Paste the message, and send it.
4. On the **Lifestream** card Muse shows, click **Connect**.
5. In **Connect Lifestream**, click **Connect**.

If Muse asks to contact Lifestream, check that the request shows your address. Click **Allow**, or
**Allow once** for a single request.

Muse opens Lifestream's sign-in page. It says "Muse wants to read your Lifestream.", then
"From agent.meta.ai, where Muse runs", and shows a number.

## Say yes in Lifestream

The guide's second step now says "Muse wants to read your Lifestream". It shows what Muse will see,
and three numbers.

1. To change what Muse will see, click **Edit**, change it, and click **Done**.
2. Click the number that Muse's sign-in page shows. Picking the number is your yes.

The guide says "Muse is connected" once Muse finishes. If Muse stopped at the sign-in, go back to
the side chat, and ask it to finish setting up the connector.

If you closed the guide, your Mac shows a notification: "Muse wants to read your Lifestream. Pick
the number it shows." Click it, and the guide opens at **Say yes here**. On your iPhone, the sign-in waits
under **Needs you** on the **Agents** tab.

## Ask it a first question

Send Muse the question the guide shows under **Ask it first**:

```
Use Lifestream to tell me what I did yesterday.
```

Muse answers from Lifestream. In Lifestream, **Agents** › **Muse** › **History** shows what it read.

## If something goes wrong

- **Muse asks where to sign in.** Send it this, with your address in place of `ADDRESS`:

  ```
  The issuer is ADDRESS without /mcp at the end. Read /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource/mcp there, then open the secure sign-in card.
  ```

- **Muse lists the tools, but a question times out.** Check that your Mac is awake, then ask
  again.

## Next

- [Choose what Muse reads](./choose-what-an-agent-reads.md)
