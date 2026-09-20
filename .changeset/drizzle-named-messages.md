---
'@nxgt/drizzle': minor
---

A pagination or cursor refusal names the call and the table.

`paginate` and `paginateByCursor` both take numbers under the same names, and
both used to refuse one with the same bare sentence:

```ts
await posts.paginate({ page: 0 });
// RangeError: paginate on "posts": page must be an integer of at least 1, not 0

await posts.paginateByCursor({ after: cursorFromAnotherPage });
// InvalidCursorError: Invalid cursor in paginateByCursor on "posts": it
//                     holds 2 value(s) where the ordering id:asc needs 1 (id)
```

The cursor messages keep `Invalid cursor` in front, because that is the part a
consumer searches for; the call is named in the middle. `decodeCursor` takes
an optional third argument to do the same for a caller paginating something
this package knows nothing about, and `pageWindow` and `cursorLimit` take an
optional trailing one. All are optional, so no existing call changes.

`cursorLimit` is now exported, beside `pageWindow`, which `@nxgt/mongo`
already did: a caller paginating something of their own could reach the
offset half of this and not the cursor half, for no reason anybody wrote
down.
