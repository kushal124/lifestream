# Example (phone template)

The `phone` kind's template (packages/connect/SKILL.md, "phone"): a synthetic stream the iPhone app records, Example's
notes. An iPhone stream is a release folder's alone: `lifestream connectors new phone <id> --into
packages/connect/ios-app/<id>` copies this folder; every name here is the copy's to change. Its Swift recorder is code in the phone app (SKILL.md names its files).

Source: `example:local:<unit>`, one per phone, from the shipment's `example` domain (`example.jsonl`). Reader:
`example-phone`. The phone decides when it ships, so the declaration states no `refresh`; it needs no grant.

The notes family reads each note (`adapter.ts`): its text, its first line the
title. It prints the note's line on its day and gives search its words. A copy whose records are no notes gives its
own type's family's adapter, by that family's contract (`packages/core/inputs/<family>.ts`), or a plain line
(templates/export/export.md, "No family fits: state a line").

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | `<install id>:<sequence>`, the recorder key | `type: "example.note"` and the entry's `payload` (`text`, `written_at`) | `payload.written_at`, RFC 3339 |

- A line is a part: one of another kind, or one that does not read, is refused alone.
- The phone ships each entry once; a shipment read again restates what it holds and makes no new version.
