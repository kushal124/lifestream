# Name your places

Give a name to the places you go, so Timeline, Search and Chat call them what you call them. Until
you name a place, Timeline says only what it is near, such as **Near Home**, or the city it is in.

## Before you start

- Places Lifestream knows you stayed at. They come from [Location](./connectors/location.md) on
  your iPhone, from [Google Maps Timeline](./connectors/google-timeline.md), or from where your
  photos were taken.

Places asks you to name a spot once you have stayed there on 3 days or more, or for an hour or more
in one day.

## Name the places Lifestream found

1. Open **Places**.
2. On your Mac, click **Start** beside the number of **places to name**. On your iPhone, tap the
   count beside the title, such as **12 to name**.
3. If the card asks **Is this home?**, click **Yes, it’s home** to put "Home" in the name field, or
   **No**.
4. The card shows the photos you took there and when you were there. Give it a name:
   - Click or tap a suggested name. Lifestream saves it and shows the next card.
   - Or type a name, and click **Save name**. On your iPhone, tap **Save**.
5. To pass a card, click **Skip**. On your iPhone, you can also swipe the card to the left.

After the last card, Places says how many places you named. Click **Done**.

To name one spot only, click its ring on the map on Places. Or click **Name it** beside an unnamed
stay on Timeline.

## Choose a suggested name

Lifestream suggests names by rules, from your own data. No AI model is asked. The line under each
name says where it came from:

- **Your place**: a place you have already named, near this spot. Pick it if the spot is part of
  that place, such as another building of your office. The spot then joins that place.
- A connector and a time, such as **Calendar · 12:30**: an event, a message, an email, a note, a
  payment or a Google Maps search that named this place around the time you were there.
- **Google**: a place Google knows near this spot.

Names from Google need a Google key in Lifestream. Without one, the card says **Names from Google
Places come once Lifestream holds a key**, with **Add key** beside it, and the other suggestions
still come. With a key, Lifestream sends Google the spot's location and the words you type.

To add a key:

1. In the Google Cloud console, turn on **Places API (New)** for a project, and make an API key.
   Google charges for what it answers past its free allowance.
2. On a naming card, click **Add key**.
3. Paste the key in **Google API key**, and save it.

Lifestream keeps the key locked with your other passwords. [What leaves your
Mac](./what-leaves-your-mac.md) says what Google gets.

## Fix a mistake

- **Undo a name.** On your Mac, press ⌘Z while the name field is empty. The last card comes back.
  On your iPhone, after you add a spot to a place you had already named, tap **Undo** within 10
  seconds.
- **Change the area.** The circle on the map shows what the name covers. On your Mac, change
  **Radius**, or drag the circle. On your iPhone, move or resize the circle on the card's map.
- **Hide a spot.** Click **Hide this place** for a spot you never want to name. Timeline then calls
  a stay there **a hidden place**. To bring the spot back, open **Hidden** at the foot of the list
  on Places, and click **Unhide**.

## Rename a place

1. Open **Places**, then the place.
2. Click **Edit**.
3. Change the **Name**, and click **Save**.

## What a name changes

- **Timeline** shows each stay there by its name, on past days too.
- **Search** shows the place in **Top hits** when you type its name, and finds your stays there.
  See [Search your life](./search.md).
- **Chat** uses the name when it says where you were, and can count your hours there.
- **Places** lists the place under its city, with its visits, its photos and the people you were
  there with.

## Next

- [Search your life](./search.md)
- [Location](./connectors/location.md), to change how closely your iPhone records where you go.
