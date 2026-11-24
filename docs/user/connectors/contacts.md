# Contacts

The Contacts connector brings your address book into Lifestream, so Lifestream knows who is who in
your messages, calls and photos. The iPhone app reads Contacts on your iPhone and sends it to
Lifestream. A Google Takeout brings in your Google Contacts the same way.

## What it brings in

- Every contact card on your iPhone, whole, with its photo.
- Each change to a card. When you delete a contact on your iPhone, the iPhone app tells Lifestream.
- From a Google Takeout: every card in your Google Contacts, with its photo.

Your whole address book comes in with the first read.

## Before you start

- The iPhone app, [paired with your Mac](../pair-your-iphone.md).
- Your Apple ID added to the iPhone app. Contacts waits for it. If you skipped it when you paired,
  open **Connectors** on your iPhone, tap **Lifestream**, type your **Apple ID**, then tap **Add**.

## Add Contacts

The iPhone app asks for Contacts during its setup. If you allowed it then, there is nothing to do.

1. On your iPhone, open Lifestream, then **Connectors**, then **Contacts**.
2. Tap **Allow**, and allow access to all your contacts when iOS asks.

If Contacts shows **Open Settings** instead, iOS asked before. Tap **Open Settings**, and give
Lifestream full access to Contacts.

On your Mac, Contacts is on **Connectors** too, with your iPhone's icon after its name.

To bring in your Google Contacts, open **Connectors** › **Google Takeout**, and tick
Contacts in your export. [Bring in your past from an export](../imports.md) gives each step.

## Where it shows up

- **People** joins the numbers and emails on one card into one person. [Join one person across
  messages, contacts and
  photos](../name-people.md#join-one-person-across-messages-contacts-and-photos) says how to join
  the rest.
- **Timeline** names the people in your messages and calls by the name on their card.
- **Search** finds a person by the nicknames on their card, which fill their **Also called**.

## What a model reads

No AI model reads Contacts, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Contacts has none of the [settings every connector has](./README.md#settings-every-connector-has). It
has no **Check every**, because your iPhone decides when to send. It has no
**History**, because your whole address book comes in with the first read.

## Limits

- With access to only some contacts, Lifestream reads only the cards you chose.
- An export never says that a contact was deleted. A card you delete at Google stays in Lifestream.
- When you edit a card at Google and bring in a new export, Lifestream keeps both versions of it.

## Problems and fixes

These are the messages only Contacts shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Allow Contacts**\
Contacts is off for Lifestream on the iPhone named under it. On that iPhone, open **Connectors**, tap
**Contacts**, then tap **Allow** or **Open Settings**, and give Lifestream full access.

**Contacts is limited**\
The iPhone named under it lets Lifestream read only some contacts. On that iPhone, open
**Connectors**, tap **Contacts**, then tap **Open Settings**, and give Lifestream full access.

**Health, Photos and Contacts start once you add your Apple ID.**\
The iPhone app shows this under the Apple ID field. Type your Apple ID, then tap **Add**.
