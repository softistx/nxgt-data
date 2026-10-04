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
	/** MongoDB's name for it; a write error carries none — see below. */
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

Match on `serverCode`, not `serverCodeName`. What decides whether the name is
there is how the server refuses, not which method was called. When it refuses
the whole command — `Unauthorized` (13), `NamespaceNotFound` (26),
`WriteConflict` (112) in a transaction, a node that is not the primary — the
answer carries a `codeName`, from any method. When the server's `insert`,
`update` or `delete` command refuses one document, the refusal is a write
error, and a write error carries the code alone. That is where duplicate keys
(11000), validator refusals (121) and a filter the server cannot read come
from, through `create`, `createMany`, `updateMany`, `deleteMany` and
`hardDeleteMany`. The `findAndModify` behind `update`, `upsert`, `delete`,
`hardDelete` and `restore` answers even a refused document as a command, with
its name. So the same refusal is `{ serverCode: 121, serverCodeName:
'DocumentValidationFailure' }` from `update` and `{ serverCode: 121,
serverCodeName: undefined }` from `updateMany`. This package does not fill the
name in from a table of its own, because a table that lagged a server release
would answer `undefined` for a new code anyway.

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
- **A refused *argument* to a collection method is a bare `TypeError` with no
  code**, and that is worth knowing if you also use `@nxgt/drizzle`, where
  the equivalent is an `ArgumentError` carrying `code: 'INVALID_ARGUMENT'`. An
  `updateMany` with no filter, or a `paginateByCursor` along a field the
  schema has not, is recognised here by catching `TypeError` and reading the
  message. Giving the collections a class of their own is a change of its own;
  until then, a handler that wants one answer for both writes its own check.
  The **wiring's** refusals are different: `defineMongo`, `openMongo` and the
  rest of [the wiring](#wiring-errors) throw a `WiringError`, a `TypeError`
  with a `code`.

A failed parse is Zod's own `ZodError`, from `create`, `update` and an
`upsert` that could not have inserted.

## Wiring errors

`WiringError` is what the wiring refuses — `defineMongo`, `openMongo`, a
derived `Mongo`'s `transaction` and `close`, and `discoverCollections` — a
configuration, a name or a call that cannot work, with a `code` beside the
sentence, so nothing has to match the message text.

```ts
import { defineMongo, WiringError } from '@nxgt/mongo';
import * as collections from './models';

try {
	defineMongo({ uri: process.env.MONGO_URI!, collections });
} catch (error) {
	if (error instanceof WiringError) {
		error.code;      // 'CONFIG'
		error.database;  // 'default' — the database it is about, when one is named
		error.key;       // the config key, collection key or path, when one is
	}
	throw error;
}
```

Errors from the collections themselves — a duplicate key, a failed
validation, a missing document — are the `DataError` of the sections above
and its subclasses, unchanged: `mongo.db.users` *is* one of this package's
collections. `WiringError` is only about the wiring.

### The codes

| `code` | Thrown by | When |
| --- | --- | --- |
| `CONFIG` | `defineMongo` | the configuration cannot work: no `uri` and no `client`, both at once, `clientOptions` beside a `client`, a `collections` with no definition in it, two keys on one server collection, `optionsFor` under a key nothing is wired under, or one of the four options the wiring decides; for [buckets](wiring/files.md), a `buckets` with no bucket in it, a bucket key a collection already holds, two keys on one bucket, `session`/`autoSync` in `bucketOptions`, or `bucketOptions` on a database with no `buckets` |
| `COLLISION` | `openMongo` | a collection or a bucket is wired under a name the driver's `Db` already has — `command`, `watch`, `collection`… — so it would be unreachable |
| `NO_DATABASE` | `transaction(fn, { on: '<name>' })` | this Mongo holds no database under that name; the message lists the ones it has. Reading `mongo.databases.<name>` does **not** throw — an unknown key is plain `undefined` |
| `SEVERAL_DATABASES` | reading `mongo.db` | the Mongo holds more than one database, so there is no "the" database to give |
| `TRANSACTION` | `transaction` | the Mongo holds several clients and the call named none, or it is already in a session and still passed `{ on }` |
| `DERIVED` | `close` | the Mongo came from `as`, `withSession` or a transaction: the clients are the root Mongo's |
| `DISCOVERY` | `discoverCollections` | the glob is missing, a matched file has no definition under the `export` asked for, or two files define the same server collection |

`code` is the field to switch on: it survives a build that ends up with two
copies of the package, which `instanceof` does not.

### What it carries

```ts
class WiringError extends TypeError {
	readonly code: WiringErrorCode;
	/** The database it is about, when one is named. */
	readonly database: string | undefined;
	/** The config key, the collection key or the path it is about. */
	readonly key: string | undefined;

	constructor(code: WiringErrorCode, message: string, options?: WiringErrorOptions);
}

type WiringErrorCode =
	| 'CONFIG'
	| 'COLLISION'
	| 'NO_DATABASE'
	| 'SEVERAL_DATABASES'
	| 'TRANSACTION'
	| 'DERIVED'
	| 'DISCOVERY';

interface WiringErrorOptions {
	database?: string | undefined;
	key?: string | undefined;
	cause?: unknown;
}
```

`database` is the key the database is named by in the configuration —
`default` for a lone one — and `key` is the collection key, the config key or
the file path the refusal is about. Neither is ever a URI: a connection
string holds the password, and the wiring prints none.

```ts
import { openMongo, WiringError } from '@nxgt/mongo';

try {
	await openMongo(config);
} catch (error) {
	if (error instanceof WiringError && error.code === 'COLLISION') {
		error.database; // 'main'
		error.key;      // 'command' — the export to rename
	}
	throw error;
}
```

### It is a `TypeError`

`WiringError` extends **`TypeError`**, not `Error`, unlike `DataError` or
`@nxgt/redis`'s `RedisError`. Every one of these is a call or
a configuration written wrong, which is what `TypeError` means — and the
wiring threw bare `TypeError`s before the class existed, so nothing that
already catches one stopped matching:

```ts
try {
	defineMongo({ databases: {} } as never);
} catch (error) {
	error instanceof WiringError;   // true
	error instanceof TypeError;  // true — still what it always was
}
```

What is new is the `code`, which a `catch` can switch on instead of reading
the sentence.

### Where each one comes from

Nothing below reaches a request handler in a working application: they are
start-up and wiring failures, and `defineMongo` is deliberately the earliest
of them.

```ts
import { defineMongo, openMongo, WiringError } from '@nxgt/mongo';
import * as collections from './models';

// CONFIG — before anything connects.
defineMongo({ collections } as never);
// WiringError: defineMongo: database "default" has neither a uri nor a client

// COLLISION — at openMongo, against the driver's own Db.
await openMongo(
	defineMongo({ uri: process.env.MONGO_URI!, collections: { command: users } as never }),
);
// WiringError: openMongo: database "default" wires a collection under "command", …

// NO_DATABASE — a transaction named on a database this Mongo does not hold.
// The types refuse the name, so this is the call that came through an `any`,
// or from JavaScript. Reading `mongo.databases.nowhere` gives `undefined`
// instead: only `on` looks a name up.
await mongo.transaction(async () => {}, { on: 'nowhere' as never });
// WiringError: No database "nowhere" in this Mongo: it has "main", "analytics".

// SEVERAL_DATABASES — `mongo.db` with more than one. Its type is `never`.
mongo.db;
// WiringError: db: this Mongo has several databases. Read the one you mean, as `mongo.databases.main`.

// TRANSACTION — several clients, and no `{ on }`.
await mongo.transaction(async (tx) => { /* … */ });
// WiringError: transaction: this Mongo holds more than one client, …

// DERIVED — closing a Mongo that `as` derived.
await mongo.as(userId).close();
// WiringError: close: this Mongo came from `as`, `withSession` or a transaction. …
```

A name no database has, and `{ on: 'nowhere' }` with it, do not compile
either: the types refuse them where they are written. The run-time refusal is
what catches the call that arrived through an `any`, or from JavaScript — and
`mongo.db` on a Mongo with several databases, whose type is already `never`.

### A start-up that reports instead of crashing

The useful thing to do with a `WiringError` is to say which database and which
key, because that is what the fix needs:

```ts
import { defineMongo, openMongo, WiringError } from '@nxgt/mongo';
import * as collections from './models';

export async function startDatabase() {
	try {
		return await openMongo(
			defineMongo({ uri: process.env.MONGO_URI!, collections }),
		);
	} catch (error) {
		if (error instanceof WiringError) {
			console.error(
				`mongo: ${error.code}` +
					(error.database ? ` on "${error.database}"` : '') +
					(error.key ? ` at "${error.key}"` : ''),
				error.message,
			);
			process.exit(1);
		}
		throw error; // a driver error: a host that does not answer, a bad password
	}
}
```

MongoDB's own refusal to connect is **not** a `WiringError`: a host that does not
answer, a wrong password, a replica set with no primary are the driver's
errors, and they reach the caller unchanged from `openMongo`. A database that
fails to open gives back every connection opened before it.

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
- [Configuration](wiring/configuration.md) — what `defineMongo` checks, key by
  key.
- [Transactions](transactions.md) — `OptimisticLockError`, and what to do
  with it.
