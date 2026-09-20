---
'@nxgt/drizzle': minor
---

An argument refused before any SQL is built is an `ArgumentError`.

```ts
import { ArgumentError } from '@nxgt/drizzle';

try {
	await posts.findMany({ orderBy: { rank: 'sideways' } });
} catch (error) {
	if (error instanceof ArgumentError) {
		// 400, not 500. `error.argument` is 'orderBy', `error.key` is 'rank'.
	}
}
```

`DataError` and its subclasses are what the **database** said; this is what
the *call* said, and the two are worth telling apart. A `where` or an
`orderBy` assembled from a query string is user input, so a handler that
wants to answer 400 rather than 500 needs to recognise it without matching
the message. It carries `code: 'INVALID_ARGUMENT'`, the `argument` it is
about, and the `key` inside that argument when one is at fault.

**It extends `TypeError`**, which is what these five refusals already threw,
so a `catch` written against the old ones still catches them.

`updateMany`, `deleteMany` and `hardDeleteMany` refusing an empty `where` is
an `ArgumentError` too, on the same argument: a `where` built from a request
that comes out empty is the caller's input, and refusing to touch every row
is a 400, not a 500. What a **definition** gets wrong — a table with no
primary key, `restore` on a table with no soft delete — stays a bare
`TypeError`: it cannot come from a request, and no handler should answer it.
