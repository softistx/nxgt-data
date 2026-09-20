# Errors

Every method turns a MongoDB error into one of this package's, so an
application catches a class instead of reading a numeric code off an error
whose shape changes with the operation that produced it.

```ts
import { ConflictError, NotFoundError, ValidationError } from '@nxgt/mongo';

try {
	await collection.create({ email: 'ada@example.com' });
} catch (error) {
	if (error instanceof ConflictError) {
		error.index;    // 'users_email_unique'
		error.keys;     // ['email']
		error.values;   // { email: 'ada@example.com' }, when the server gives them
	}
	throw error;
}
```

A driver error that is none of them reaches you untouched.

## The classes

| Error | `code` | When |
| --- | --- | --- |
| `NotFoundError` | `NOT_FOUND` | a method by `_id` matched nothing |
| `ConflictError` | `CONFLICT` | a unique index refused the write (`E11000`); `put({ id })` named a file the bucket already has; or one of [`putOnce`'s four](gridfs.md#what-putonce-refuses) |
| `ValidationError` | `VALIDATION` | the collection's `$jsonSchema` validator refused it (121) |
| `OptimisticLockError` | `OPTIMISTIC_LOCK` | the version in the patch no longer matches |
| `InvalidCursorError` | `INVALID_CURSOR` | a cursor this package did not write, or one written for another ordering |
| `InvalidIdError` | `INVALID_ID` | a value that is no `ObjectId`, nor the string of one — from `toObjectId`, `toObjectIds`, `objectIdParam`, and `put({ id })` |
| `CorruptFileError` | `CORRUPT_FILE` | a stored file is missing chunks, or one is short — raised while its bytes are read |
| `MigrationError` | `MIGRATION` | a migration failed, or the list does not match the records — from `@nxgt/mongo/migrations` |
| `MigrationLockedError` | `MIGRATION_LOCKED` | another run holds the migration lock, or this one lost it — from `@nxgt/mongo/migrations` |
| `DataError` | `DATABASE` | any other server error, with its `serverCode` |

All of them extend `DataError`, so one `catch` covers the lot:

```ts
import { DataError } from '@nxgt/mongo';

if (error instanceof DataError) log.warn({ code: error.code, collection: error.collection });
```

`@nxgt/mongo/gridfs` re-exports the errors it raises — `NotFoundError`,
`ConflictError`, `ValidationError`, `CorruptFileError`, `InvalidIdError`,
`InvalidCursorError` — so catching one does not mean importing the root
package beside it; they are the very same classes, and `instanceof` holds
across both entry points. `@nxgt/mongo/migrations` exports its own two,
`MigrationError` and `MigrationLockedError`, and `DataError` itself is on the
root.

## What they carry

```ts
class DataError extends Error {
	readonly code: DataErrorCode;
	readonly collection: string | undefined;
	/** The `_id` a method by id was given. */
	readonly id: unknown;
	/** MongoDB's numeric code: 11000, 121, 26… */
	readonly serverCode: number | undefined;
	readonly serverCodeName: string | undefined;
	/** The index a conflict names. */
	readonly index: string | undefined;
	/** The fields it is about: an index's keys, or a validator's paths. */
	readonly keys: string[];
	readonly values: Record<string, unknown> | undefined;
	readonly issues: ValidationIssue[];
	readonly expectedVersion: number | undefined;
	readonly actualVersion: number | undefined;
}

interface ValidationIssue {
	/** The dotted path of the field, empty for the document itself. */
	path: string;
	/** The rule it broke: `bsonType`, `required`, `minimum`… */
	reason: string;
	specifiedAs?: unknown;
	consideredValue?: unknown;
	consideredType?: string;
	description?: string;
}
```

`ValidationError.issues` is MongoDB's `errInfo`, flattened — the server says
which field and which rule, and this is where to read it:

```ts
catch (error) {
	if (error instanceof ValidationError) {
		return c.json(
			{ errors: error.issues.map(({ path, reason }) => ({ path, reason })) },
			422,
		);
	}
}
```

`MigrationError` adds `migration`, and `MigrationLockedError` adds `holder`
and `expiresAt`.

## Turning them into answers

`code` is a string, so a mapping is a record and not a chain of
`instanceof`:

```ts
import { DataError, type DataErrorCode } from '@nxgt/mongo';

const status: Partial<Record<DataErrorCode, number>> = {
	NOT_FOUND: 404,
	CONFLICT: 409,
	VALIDATION: 422,
	OPTIMISTIC_LOCK: 409,
	INVALID_ID: 400,
	INVALID_CURSOR: 400,
};

app.onError((error, c) => {
	if (error instanceof DataError) {
		return c.json({ error: error.message, code: error.code }, status[error.code] ?? 500);
	}
	return c.json({ error: 'internal' }, 500);
});
```

Two things that are **not** errors here, and are worth deciding about on
purpose:

- A malformed id on a read is a `NotFoundError`, not an `InvalidIdError`: the
  collection hands an unreadable string on rather than throwing. Call
  [`toObjectId` or `objectIdParam`](documents.md#when-a-malformed-id-should-be-a-400)
  where a 400 is wanted.
- A write refused before anything is sent — a stamp a caller may not write, a
  filter an [upsert](upsert.md#the-filter-is-written-not-only-matched) cannot
  seed from — is a `TypeError`, not a `DataError`. The types refuse most of
  them first.

A failed parse is Zod's own `ZodError`, from `create`, `update` and an
`upsert` that could not have inserted.

## Raising one yourself

`toDataError` is the translation, exported for a place this package does not
reach — a raw write, a driver call of your own:

```ts
import { toDataError } from '@nxgt/mongo';

try {
	await collection.raw.insertOne(document);
} catch (error) {
	throw toDataError(error, { collection: 'users' });
}
```

It reads the error's fields rather than its class, so it survives two copies
of the driver in one tree — and so a duplicate key from `insertOne` and one
from a bulk write come out as the same `ConflictError`. A duplicate key from
a bulk write carries no `values`: MongoDB puts `keyPattern` and `keyValue` on
a single write's error only.

## Next

- [Troubleshooting](../troubleshooting.md) — the same errors, indexed by the
  message you are staring at.
- [Transactions](transactions.md) — `OptimisticLockError`, and what to do
  with it.
