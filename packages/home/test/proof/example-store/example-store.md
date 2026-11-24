# Example Store (a proof connector)

A home connector of the proof: a Mac app's store, declared as data (store.ts) and
shipped by the released Mac app's one store shipper, which holds it until the person allows it on that Mac.
Synthetic: no app of this name exists, and no release holds this folder.

Source: `example-store:local:<unit>`. Feeder `example-store-mac`; the bundle's member `store.sqlite`, the app's
`store.db`. Reader: `example-store`. The notes family reads each note (adapter.ts): its title, and its body under it.

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | the row's `id` | `{ type: "example-store.note", note: { id, title, body, created, modified } }` | `created` to `modified`, Unix seconds |
