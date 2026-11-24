# Choose what an agent reads

Each agent reads only what you allow it. You choose its connectors, how far back it reads, and
what stays hidden, and you can change that at any time. This guide also says how to answer an
agent that asks for more, and how to see everything an agent read.

An agent is an AI app, such as Claude, ChatGPT or Muse, that you let read your Lifestream.
[Connect an agent](./connect-an-agent.md) says how to connect one. On your Mac, agents are on the
**Agents** page in the sidebar. On your iPhone, tap the **Agents** tab.

## What an agent reads

What one agent may read is its access. An access has three parts:

- **Reads:** the kinds of data it may read, such as Mail, Messages or Health, and inside each kind
  the accounts it may read, such as one Gmail address.
- **How far back:** how far back it reads: all time, since a date, or only the past hour, 24 hours,
  7 days, 30 days or year.
- **Hides:** what Lifestream hides in what the agent reads. **Details** shows names and hides
  details such as phone numbers and addresses. **Names and details** hides both. **Nothing** hides
  nothing. **Choose…** lets you pick each kind of detail.
  [What leaves your Mac](./what-leaves-your-mac.md#what-is-hidden-before-sending) says what each
  kind of detail is.

By default, a new agent reads everything but Health and Money, from all time, with details hidden
and names shown. It also reads the connectors you add later, except Health and Money ones. Names
are the one difference from the rest of Lifestream: connectors and Chat hide names before they send
anything to a model. To hide names from an agent too, set its **Hides** to **Names and details**.

An agent reads a day line, a place visit or a number only when it may read every connector that
made it. For example, a stay that Lifestream joined from your iPhone and your Mac needs both. A visit,
a night or a meeting that started before **How far back** is left out whole.

When an agent searches and something it may not read matches, its answer ends with the line "More
matched outside your access." It never says what matched, how much, or where. An agent that opens
one thing outside its access gets "Outside your access." and nothing else.

What an agent reads goes to that app, and to the company that runs it, and stays with them under
their own terms. A shorter access only stops what it reads next: it cannot take back what the agent
already read. [What leaves your Mac](./what-leaves-your-mac.md#what-each-company-keeps) says which
setting to check at each company.

## Choose when an agent connects

Each app's guide shows what the agent will see before it reads anything. When an app signs in,
your Mac or your iPhone says "Claude wants to read your Lifestream". Under **It will see**, it shows
what the agent **Reads**, **How far back**, and what it **Hides**. A guide that makes a key, for
Grok Bot, Instinct or another agent, shows the same under **It will see**, before **Make the key**.

1. To read less or more, click **Edit**.
2. Change what the agent reads, as [Change what an agent reads](#change-what-an-agent-reads) says.
3. Click **Done**.
4. Click the number the agent's sign-in page shows, or **Make the key**.

The agent gets the access shown when you pick the number or make the key. To refuse a sign-in,
click **Don't allow**.

To connect without sharing records, click **Edit**, select **Only these**, and clear every checked
category. Click **Done**, and check that **Reads** says "Reads nothing" before you approve. The app
can still call a tool. Lifestream blocks the read and shows the attempt under **History**.

## Change what an agent reads

1. Click **Agents** in the sidebar, then click the agent. On your iPhone, tap the **Agents** tab,
   then the agent.
2. Click **Reads**, under **Access**.
3. Change what it reads. A change that lets the agent read less is saved at once. A change that
   lets it read more waits: click **Allow** at the foot of the page to save it, or **Cancel**.

On **Access**:

- In either mode, a checked category is allowed. **Everything but** also allows new categories.
  **Only these** keeps unchecked categories off. A checked category can include accounts you add
  later. To allow specific accounts, expand the category and choose those accounts.
- Each row shows the category, its accounts, its time limit and how often the agent read it in
  the past 30 days. If you see **Show 4 more**, click it to see the rest of the list.
- **How far back** sets how far back the agent reads everything.
- **Hides** sets what stays hidden. **Choose…** opens a page where you pick each kind of detail.

After a change that lets the agent read less, the foot of the page says what stopped, such as
"Claude no longer reads Messages.", with **Undo**. Undo works in the Lifestream window on your Mac
and on your iPhone.

If a change lets the agent read your screen, Lifestream first says "Screen shows almost everything
you did." Click **Allow** to keep the change, or **Cancel**. The screen shows whatever was on it,
Health and Money apps included.

To stop an agent for good, disconnect it, as [Disconnect an agent](#disconnect-an-agent) says.

### Change it with Chat

You can ask Chat in words, such as "Let Claude read only my mail from the past week".

- If the change lets the agent read less, Chat makes it at once and shows a line that says what
  the agent reads now. Click **Undo** to take it back.
- If the change lets the agent read more, Chat shows a card, such as "Let Claude also read
  Health?". Click **Allow** to make the change, or **Don't allow**. The same question waits under
  **Needs you** on the Agents page, on the agent's row.

Only a click on your Mac or your iPhone lets an agent read more. Chat, an agent, or text in your
messages never can.

### Change it from Terminal

On the Mac that holds Lifestream, run this command in Terminal to print what an agent reads.
Replace `p-1a2b3c4d` with the agent's id, which `~/.local/bin/lifestream agents` lists.

```sh
~/.local/bin/lifestream agents access p-1a2b3c4d
```

`~/.local/bin/lifestream help agents` lists the other commands, such as `agents access <id> set` and
`agents history <id>`.

## Answer an agent that asks for more

An agent that needs more can ask you. It names what it wants and says why. Each request waits one
day for your answer.

- **On your Mac,** a notification names the agent and what it asks for, such as "Claude asks for
  all of WhatsApp for 1 hour", with its reason in quotes. Click it. The Lifestream window shows the
  request.
- **On your iPhone,** open Lifestream. A request still waiting comes up as you open the app. When
  two wait, it says "1 of 2".

The request says what the agent asks for and what it reads today, such as "Today it reads all but
Health and Money". Under **Claude says** is the agent's reason, in its own words: read it as a
claim, not as a fact. Choose one:

- **Allow for 1 hour**, or the time the agent asked for, allows it for that long. The access then
  ends by itself, and the request says "Allowed until" that time.
- **Always allow** allows it until you change the access.
- **Don't allow** declines it. The agent can ask for the same thing again only after one day, and
  after a second **Don't allow**, only once you change its access yourself.
- **Edit** opens the access with the request added, so you can allow part of it. Click **Allow**
  to save it.

On your Mac, Return picks the highlighted answer, and Esc doesn't allow.

If the agent asks for a connector, such as Spotify, the request covers that connector's current
accounts. Records about the same app can come from another connector. For example, a Spotify play
can come from **Now playing**. Open the category under **Reads** to see the accounts it contains.

After you answer a request, tell the agent in its chat to check Lifestream access and retry the
same question. A count of zero with a message about matches outside its access counts only what
the agent can see. Check **History** for the request, your answer and the new count.

A request waits under **Needs you** on the Mac's **Agents** page. On your iPhone, find it under
**Needs you** on **Agents** or **Connectors** and tap **Review**.

## See what an agent read

1. Click **Agents** in the sidebar, then click the agent. On your iPhone, tap the **Agents** tab,
   then the agent.
2. Read **History**. Click **See all history** for every read; on the iPhone, tap **See all**.

**History** groups the agent's reads by day, then by session, newest first, such as "10:15 – 10:40 ·
26 reads". Each line says what the agent did, in its own words, and what came back at the end, such
as "Searched dentist" and "1 record". A long run of reads folds into one line, such as "21 more";
click it to open them. Click a read to see what left Lifestream, and what was not shown and why,
such as "4 more matched but weren't shown: outside what it reads". The agent never learns what was
not shown. Each change of the access sits on its own line, with who made it. The filters at the top
show one kind, or reads or changes only. Click **Earlier** for older sessions.

The history keeps what the agent typed, and which items each answer carried, but never the text
of an answer. It is kept for as long as
Lifestream is. When you erase something it read, the history keeps the line and says "a record
since erased".

## Disconnect an agent

To stop an agent reading Lifestream, disconnect it, as
[See and disconnect an agent](./connect-an-agent.md#see-and-disconnect-an-agent) says.

## Next

- [Connect an agent](./connect-an-agent.md), to connect another app.
- [The tools an agent gets](./agent-tools.md), to see what an agent's tools answer.
- [What leaves your Mac](./what-leaves-your-mac.md), to see what is hidden before anything leaves.
