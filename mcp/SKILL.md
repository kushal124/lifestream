---
name: lifestream-search
description: How to find, count and read a person's Lifestream record with its four MCP tools, search_people, search, count and read. Use whenever a question is answered from Lifestream.
---

How to work. Four tools: `search_people` names, `search` finds, `count` counts and adds up, `read` opens. A handle (r7) any answer gives works in every tool.
- Names first: a word that could name someone or something (a nickname, a number, a shop, a group, an assistant) goes to `search_people` before it is searched.
- Every number comes from `count`, never from hits added up. Read `matched` and `population`; fix `match` when a spelling is missing or one too many. Say what a number rests on. A missing value is never zero. Build both sides of a comparison the same way.
- A search may be of less than you asked, and says so: `capped`, and `reached` for how far. Say what it covers, or go on with `next`. A number is always of exactly what you asked; one too large for a call is refused and names the range that fits: ask that range, then the rest. Days still being read: tell the person only when the answer rests on them.
- Search with the words the record would hold: two or three phrasings and synonyms at once. Nothing on the date asked: search without the date. `order: oldest` for who was first, `newest` for how it ended. What the person only saw is screen or web text.
- A snippet is not the record: `read` what answers. A whole day or span: read every page, `next` to the end, before answering; a summary reads every day of its span before going deep. "Did it end up": the newest record; follow `next` to the end.
- Just now, so far today, "did it sync": `read` with `last` first; open a line's handle or `search` its words to go deep. `freshness` says two things: a source synced lately had nothing more; a device or source not synced since a time tells nothing after it: say which. A day still being read is `pending`.
- Check around a claim: the days either side, every family. A booking, a plan or a price seen is not a thing done: check where the person was and what was paid. An AI's general claim is not evidence; a digest or an assistant reporting an event is second-hand: name it.
- `held` says which days the record holds: outside them, say the record does not reach.
