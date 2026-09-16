---
'@nxgt/mongo': minor
---

Stamps are options of `defineCollection`, and collections carry MongoDB's own options

**Breaking.** The four spread helpers are gone. A field added by hand was only
a field — spreading `...softDelete()` never made `delete` soft — so the stamps
became options that add their fields to the schema *and* turn the behaviour on.

```ts
// before
schema: z.object({ _id: id(), email: z.email(), ...timestamps(), ...softDelete() }),

// now
schema: z.object({ _id: id(), email: z.email() }),
timestamps: true,
softDelete: true,
```

| removed | replaced by |
| --- | --- |
| `...timestamps()` | `timestamps: true` |
| `...softDelete()` | `softDelete: true` |
| `...optimisticLock()` | `optimisticLock: true` |
| `...actors(type?)` | `actors: true` or `actors: { type }` |
| `stampsOf(schema)` | `definition.stamps` |

Each option is `true`, `false`, or an object naming its fields one by one —
`softDelete: { deletedAt: 'removedAt' }`, `actors: { createdBy: 'openedBy',
deletedBy: false }`. Inside that object an absent key means on under its
default name; only `false` turns a field off. The name then follows
everywhere: the document type, the `$jsonSchema` validator, the field `delete`
writes, and the fields an index may be keyed on — indexing `deletedAt` on a
collection that renamed it no longer compiles. The single-field builders
(`timestampField`, `deletedAtField`, `versionField`, `actorFieldOf`) stay, for
a field with no behaviour attached.

`ActorOf` now reads the actor's type under the name the option gave it. It was
looking for a literal `createdBy`, so a renamed actor field resolved to `never`
and made `as()` uncallable — silently, since that compiles.

**MongoDB's own collection options** are part of the definition:
`options: { capped: { size, max }, timeseries: { timeField, metaField },
collation, clusteredIndex, expireAfterSeconds, changeStreamPreAndPostImages }`,
keyed on the schema's fields where they name one. `capped` is one object rather
than three sibling keys, because the server refuses `capped` without a `size`.
`sync` creates the collection with them, changes the few `collMod` accepts, and
throws on the rest naming the option, the live value and the wanted one;
`dryRun` lists every difference instead. Only what the definition asks for is
compared, because MongoDB fills its own defaults into `collation` and
`timeseries` and an equality check would report a difference on every run.
A time-series collection gets no validator — MongoDB refuses one — so
`validation.level` defaults to `'off'` there and asking for another throws
where the definition is written.

**`syncAll(db)`** syncs every collection `defineCollection` has built, with no
list to keep: importing the module that defines one registers it.
**`getCollection(db, def, { autoSync: true })`** syncs once per database before
the first operation, for tests and development — `resetAutoSync(db)` forgets
it, which a suite that drops its database between cases needs.
