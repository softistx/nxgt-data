---
'@nxgt/mongo': minor
---

A connect that a close interrupts is a `ConnectionError`, not a bare `Error`.

```ts
import { ConnectionError } from '@nxgt/mongo';

try {
	await connectMongo(uri);
} catch (error) {
	if (error instanceof ConnectionError) {
		// The shared client went away mid-connect: worth trying again.
	}
}
```

It is a `DataError` like the rest of this package's failures, with
`code: 'CONNECTION'`, so a handler that already maps `DataError` codes to
statuses covers it without a second branch. MongoDB's own refusal to connect
is still the driver's error, unchanged — this is only what *this* package
decides.

**It carries no URI**, and a spec asserts it: a connection string holds the
password, and this package prints none.
