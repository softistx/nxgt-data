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
| `InvalidCursorError` | `INVALID_CURSOR` | a cursor this package did not write, or one written for another ordering. The message [names the call and the collection](pagination.md#what-a-refused-cursor-says) |
| `InvalidIdError` | `INVALID_ID` | a value that is no `ObjectId`, nor the string of one — from `toObjectId`, `toObjectIds`, `objectIdParam`, and `put({ id })` |
| `CorruptFileError` | `CORRUPT_FILE` | a stored file is [missing a chunk, or one is short, or one holds something that is not bytes](gridfs.md#a-file-is-found-whole-and-only-reading-it-says-otherwise) — raised while its bytes are read, and naming the chunk, the file and the bucket |
| `MigrationError` | `MIGRATION` | a migration failed, or the list does not match the records — from `@nxgt/mongo/migrations` |
| `MigrationLockedError` | `MIGRATION_LOCKED` | another run holds the migration lock, or this one lost it — from `@nxgt/mongo/migrations` |
| `ConnectionError` | `CONNECTION` | `closeMongo()` ran while this [`connectMongo`](connecting.md#a-connect-that-closemongo-interrupts) was still connecting |
| `DataError` | `DATABASE` | any other server error, with its `serverCode` — and the one answer MongoDB should never give, an [`upsert` answered with no document](upsert.md#what-it-throws) |

`ConnectionError` is the one that is not a server answer: MongoDB's own
refusal to connect — a host that does not answer, an auth failure — is the
driver's error and reaches you unchanged. `CONNECTION` is only what *this*
package decides, and it carries neither a URI nor a collection. See
[Connecting](connecting.md#a-connect-that-closemongo-interrupts).

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
	CONNECTION: 503,
};

app.onError((error, c) => {
	if (error instanceof DataError) {
		return c.json({ error: error.message, code: error.code }, status[error.code] ?? 500);
	}
	return c.json({ error: 'internal' }, 500);
});
```

What is **not** a `DataError` here, and is worth deciding about on purpose:

- A malformed id on a read is a `NotFoundError`, not an `InvalidIdError`: the
  collection hands an unreadable string on rather than throwing. Call
  [`toObjectId` or `objectIdParam`](documents.md#when-a-malformed-id-should-be-a-400)
  where a 400 is wanted.
- A write refused before anything is sent — a stamp a caller may not write,
  an [`_id` in a patch](documents.md#_id-never-changes), a filter an
  [upsert](upsert.md#the-filter-is-written-not-only-matched) cannot
  seed from — is a `TypeError`, not a `DataError`. The types refuse most of
  them first. The exception is the one thing about an `upsert` that cannot be
  the caller's doing: a server that
  [answers it with no document](upsert.md#what-it-throws) is a `DataError`
  with `code: 'DATABASE'`, so a handler is not left reading messages to tell
  a bug from a mistake.
- A `page`, a `pageSize` or a `limit` that is not a positive integer is a
  `RangeError`, and it [names the call](pagination.md#by-page-number):
  `paginate on "users": page must be an integer of at least 1, not 0`. It is
  a client's input as often as not, so it is a 400 too — and it is not a
  `DataError`, so the mapping below does not catch it.
- **A refused *argument* here is a bare `TypeError` with no code**, and that
  is worth knowing if you also use `@nxgt/drizzle`, where the equivalent is
  an `ArgumentError` carrying `code: 'INVALID_ARGUMENT'`. An `updateMany`
  with no filter, or a `paginateByCursor` along a field the schema has not,
  is recognised here by catching `TypeError` and reading the message. Giving
  this package a class of its own is a change of its own; until then, a
  handler that wants one answer for both writes its own check.

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
