# Example (label template)

The `label` kind's template (packages/connect/SKILL.md, "label"): a labeler the home runs over what it holds, stating
how many notes the person wrote each month. A labeler is a release folder's alone: `lifestream connectors new label <id>
--into packages/connect/labelers/<id>` copies this folder; every name here is the copy's to change.

Source: `example:local:<home>`, the labeler's own, made from its first delivery's facts. Labeler and reader:
`example-label`, which the declaration's `label` names and the registry builds. Its inputs are every source's `note`
records; it sits under no type.

| Kind | Key | Content | Time |
|---|---|---|---|
| `month` | `YYYY-MM` | `notes`: the held notes written in it | the month, UTC |

- A delivery is `months.ndjson`, one line a month whose count changed (`{"content":{"notes":2},"key":"2026-09","kind":"month"}`),
  or a month no note holds any more (`{"gone":true,"key":"2026-08","kind":"month"}`).
- A run that finds every month as stated delivers nothing. A line is a part: one that does not read is refused alone.
