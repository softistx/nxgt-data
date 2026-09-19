---
'@nxgt/mongo': minor
---

A string that arrives from outside is now read from the schema, so a handler
no longer parses ids or dates before a query.

`getCollection` reads the collection's Zod schema once and converts, in
filters, in writes, in hooks and in the id argument of `findById`, `getById`,
`update`, `delete`, `hardDelete` and `restore`: a 24-hex string where the
schema says `bsonType: 'objectId'` becomes an `ObjectId`, and a date string
where it says `z.date()` becomes a `Date`. The same happens inside `$eq`,
`$ne`, the comparisons, `$in`, `$nin`, `$all`, `$each` and `$not`, under
`$and`/`$or`/`$nor`, at a nested path and in the `$elemMatch` that names it, in
a patch of fields and in one written in operators, and in `onChange`'s filter.

The types say the same thing: an `ObjectId` field takes `ObjectId | string`
and a `Date` field takes `Date | string`, everywhere the collection reads one.
`FilterOf<Def>` and `NewOf<Def>` are exported for typing your own functions
over them. The hooks are unchanged and still see the stored forms: the reading
happens before they run.

Nothing is guessed at, because a wrong guess is a query that silently matches
nothing. An id is 24 hexadecimal characters; a date is `2026-01-01`, or a time
with a zone on it — `'5'`, `'2026'`, `'2026-02-31'` and `'2026-01-01T00:00'`
are all things `new Date` reads and none of them means one instant, so all four
are handed on for the schema to refuse by name. A number is never a date, and a
field the schema does not declare is passed to the server untouched.

`coerce: false` turns it off for a collection.
