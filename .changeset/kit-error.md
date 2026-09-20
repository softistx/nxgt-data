---
'@nxgt/mongo-kit': minor
---

Every refusal this package makes is a `KitError`, with a code to switch on.

```ts
import { KitError } from '@nxgt/mongo-kit';

try {
	await createKit(config);
} catch (error) {
	if (error instanceof KitError && error.code === 'COLLISION') {
		// `error.database` and `error.key` name where, without parsing the text.
	}
}
```

`code` is one of `CONFIG`, `COLLISION`, `NO_DATABASE`, `SEVERAL_DATABASES`,
`TRANSACTION`, `DERIVED` or `DISCOVERY`; `database` and `key` carry which
database and which collection key it is about. Until now every one of these
was a bare `TypeError` with the answer only in the sentence, so a caller that
wanted to tell a configuration collision from a missing database had to match
message text.

**It extends `TypeError`, not `Error`**, because that is exactly what these
were before it existed: a `catch` that already tests `error instanceof
TypeError` keeps catching them, and gains a `code` it can read. The class,
`KitErrorCode` and `KitErrorOptions` are exported.

Two messages say more than they did. A `databases` block that is not one now
names the shape — `{ databases: { main: … } }` — and says a single database
is the configuration itself, naming itself with `database`; it used to state
only that the value was wrong. An empty one now says to give it at least one,
with the same shape.
