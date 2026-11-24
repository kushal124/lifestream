# Check-ins

The Check-ins connector brings in your answers to short questions about how you feel, and your
scores on a three-minute reaction test. You answer them in the iPhone app, and your iPhone sends
them to Lifestream.

## What it brings in

- Each check-in you answer: the form, your answer to each question, and the note you add.
- Each reaction test: the time you took to react to each signal, including taps that came too
  early.
- Each question the app asked you, and whether you answered it.

These are the forms:

| Form | What it asks | When |
|---|---|---|
| **Right now** | How pleasant, how full of energy, and how tense you feel | Any time |
| **Today** | How today felt, how worthwhile, and how connected to people | At your bedtime |
| **This week** | How satisfied you are with your life as a whole, from 0 to 10 | After **Today**, on Sundays |
| **Before work** | How clear-headed and how sleepy you feel, then the reaction test | Any time |
| **Work block** | What a block of work is for, then how it went | After a reaction test |

**Today** and **This week** come only with **Ask through the day** on (see
[Settings](#settings)).

After a reaction test, tap **Start a work block** to say what you are about to work on. The next
time you open **Before work**, it asks how the block went. A block that you do not stop ends by
itself after three hours.

## Before you start

- Lifestream on your iPhone, [paired](../pair-your-iphone.md) with your Mac.
- Notifications allowed for Lifestream. Only **Ask through the day** uses them, but Check-ins
  shows **Allow Notifications** until you allow them.

## Add Check-ins

1. On your iPhone, open **Connectors** and tap **Check-ins**.
2. Under **Notifications**, tap **Allow**, and allow notifications when iOS asks.

To check in at any time, tap **+** at the top of **Timeline**, then **Check-in**. For the reaction
test, tap **Check in now** in Check-ins, then **Before work**.

On your Mac, Check-ins is on **Connectors** too, with your iPhone's icon after its name.

## Where it shows up

- **Timeline** shows each check-in as **Check-in**, with your answers and your note. It shows each
  reaction test as **Vigilance test**, with its **Median** reaction time and its **Lapses**, the
  reactions of 500 ms or slower.
- **Search** finds a check-in by the words of your note.
- **Chat** reads your check-ins when a question needs them.

## What a model reads

No AI model reads Check-ins, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Check-ins has none of the [settings every connector has](./README.md#settings-every-connector-has). It
has two settings of its own, on its page on your iPhone:

- **Ask through the day** sends a notification when it is time to check in. It is off unless you
  turn it on.
- **Bedtime** is when the app asks **Today**, from 21:00 to 02:00. The default is 23:30.

With **Ask through the day** on, the app asks **Right now** twice a day, at random times between
2 hours after you wake and 2 hours before your bedtime. It takes your wake time from Health when
Health has one, and uses 8:00 when it does not. Each question stays open for 15 minutes, with a
reminder after 5. For 28 days after your first **Before work**, it also asks for a reaction test
at 15:00 on Mondays, Wednesdays and Fridays.
