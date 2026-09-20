---
'@nxgt/mongo': minor
---

Every refusal that had a sentence and nothing else now names what failed.

**A pagination number says which call refused it.** A collection's `paginate`
and `paginateByCursor` and a bucket's `paginate` all take a `page`, a
`pageSize` or a `limit`, and all three used to refuse one with `limit must be
an integer of at least 1, not 0` — the same sentence, so a log line said which
listing produced it never.

```ts
await files.paginate({ limit: 0 });
// RangeError: paginate on "uploads": limit must be an integer of at
//             least 1, not 0
```

The bucket's own check was a second copy of the collection's; it is now the
same one. It takes no maximum, because a bucket has no `maxPageSize` and
giving it one here would cap a listing that is uncapped today.

**A cursor says which listing rejected it, and along which columns.**

```ts
await posts.paginateByCursor({ after: cursorFromAnotherPage });
// InvalidCursorError: Invalid cursor in paginateByCursor on "posts": it
//                     holds 2 value(s) where the ordering _id:asc needs 1 (_id)
```

**And it wears the cursor class.** That one refusal was a bare `DataError`
with `code: 'DATABASE'`, while the three beside it were `InvalidCursorError`
with `INVALID_CURSOR` — so a handler mapping codes to statuses answered 500
to the one cursor failure a client can cause by pasting the wrong page's
link. It is an `InvalidCursorError` now, and one `catch` takes all four.

The lead stays where it was, because `Invalid cursor` is the part a consumer
searches for. `decodeCursor` takes an optional third argument for the same
reason; `pageWindow` and `cursorLimit` take an optional trailing one. All are
optional, so no existing call changes.

**A GridFS chunk that holds no bytes names the chunk, the file and the
bucket**, the way a missing chunk and a truncated one already did:

```
Chunk 4 of file 6721… in "uploads" holds a string where its bytes should be:
the chunk was written by something that is not GridFS, or its `data` was
overwritten
```

It reports the *shape* of what was stored, never its value.

**An upsert the server answers with no document is a `DataError`, not a
`TypeError`.** MongoDB does not do that, and the message now says so and says
where to report it. It mattered because every other refusal of the same call
*is* a `TypeError` written by this package and *is* the caller's mistake:
wearing the same class and the same `upsert: "users"` prefix left no way to
tell the caller's mistake from the one thing that should never happen.
