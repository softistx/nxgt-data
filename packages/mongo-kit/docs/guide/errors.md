# Errors

`KitError` is what this package refuses — a configuration, a name or a call
that cannot work — with a `code` beside the sentence, so nothing has to match
the message text.

```ts
import { defineConfig, KitError } from '@nxgt/mongo-kit';
import * as collections from './models';

try {
	defineConfig({ uri: process.env.MONGO_URI!, collections });
} catch (error) {
	if (error instanceof KitError) {
		error.code;      // 'CONFIG'
		error.database;  // 'default' — the database it is about, when one is named
		error.key;       // the config key, collection key or path, when one is
	}
	throw error;
}
```

Errors from the collections themselves — a duplicate key, a failed
validation, a missing document — are `@nxgt/mongo`'s `DataError` and its
subclasses, unchanged: `kit.db.users` *is* one of its collections. `KitError`
is only about the wiring.

## The codes

| `code` | Thrown by | When |
| --- | --- | --- |
| `CONFIG` | `defineConfig` | the configuration cannot work: no `uri` and no `client`, both at once, `clientOptions` beside a `client`, a `collections` with no definition in it, two keys on one server collection, `optionsFor` under a key nothing is wired under, or one of the four options the kit decides |
| `COLLISION` | `createKit` | a collection is wired under a name the driver's `Db` already has — `command`, `watch`, `collection`… — so it would be unreachable |
| `NO_DATABASE` | `transaction(fn, { on: '<name>' })` | this kit holds no database under that name; the message lists the ones it has. Reading `kit.databases.<name>` does **not** throw — an unknown key is plain `undefined` |
| `SEVERAL_DATABASES` | reading `kit.db` | the kit holds more than one database, so there is no "the" database to give |
| `TRANSACTION` | `transaction` | the kit holds several clients and the call named none, or it is already in a session and still passed `{ on }` |
| `DERIVED` | `close` | the kit came from `as`, `withSession` or a transaction: the clients are the root kit's |
| `DISCOVERY` | `discoverCollections` | the glob is missing, a matched file has no definition under the `export` asked for, or two files define the same server collection |

`code` is the field to switch on: it survives a build that ends up with two
copies of the package, which `instanceof` does not.

## What it carries

```ts
class KitError extends TypeError {
	readonly code: KitErrorCode;
	/** The database it is about, when one is named. */
	readonly database: string | undefined;
	/** The config key, the collection key or the path it is about. */
	readonly key: string | undefined;

	constructor(code: KitErrorCode, message: string, options?: KitErrorOptions);
}

type KitErrorCode =
	| 'CONFIG'
	| 'COLLISION'
	| 'NO_DATABASE'
	| 'SEVERAL_DATABASES'
	| 'TRANSACTION'
	| 'DERIVED'
	| 'DISCOVERY';

interface KitErrorOptions {
	database?: string | undefined;
	key?: string | undefined;
	cause?: unknown;
}
```

`database` is the key the database is named by in the configuration —
`default` for a lone one — and `key` is the collection key, the config key or
the file path the refusal is about. Neither is ever a URI: a connection
string holds the password, and this package prints none.

```ts
import { createKit, KitError } from '@nxgt/mongo-kit';

try {
	await createKit(config);
} catch (error) {
	if (error instanceof KitError && error.code === 'COLLISION') {
		error.database; // 'main'
		error.key;      // 'command' — the export to rename
	}
	throw error;
}
```

## It is a `TypeError`

`KitError` extends **`TypeError`**, not `Error`, unlike `@nxgt/mongo`'s
`DataError` or `@nxgt/redis`'s `RedisError`. Every one of these is a call or
a configuration written wrong, which is what `TypeError` means — and this
package threw bare `TypeError`s before the class existed, so nothing that
already catches one stopped matching:

```ts
try {
	defineConfig({ databases: {} } as never);
} catch (error) {
	error instanceof KitError;   // true
	error instanceof TypeError;  // true — still what it always was
}
```

What is new is the `code`, which a `catch` can switch on instead of reading
the sentence.

## Where each one comes from

Nothing below reaches a request handler in a working application: they are
start-up and wiring failures, and `defineConfig` is deliberately the earliest
of them.

```ts
import { createKit, defineConfig, KitError } from '@nxgt/mongo-kit';
import * as collections from './models';

// CONFIG — before anything connects.
defineConfig({ collections } as never);
// KitError: defineConfig: database "default" has neither a uri nor a client

// COLLISION — at createKit, against the driver's own Db.
await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections: { command: users } as never }),
);
// KitError: createKit: database "default" wires a collection under "command", …

// NO_DATABASE — a transaction named on a database this kit does not hold.
// The types refuse the name, so this is the call that came through an `any`,
// or from JavaScript. Reading `kit.databases.nowhere` gives `undefined`
// instead: only `on` looks a name up.
await kit.transaction(async () => {}, { on: 'nowhere' as never });
// KitError: This kit has no database "nowhere": it has "main", "analytics".

// SEVERAL_DATABASES — `kit.db` with more than one. Its type is `never`.
kit.db;
// KitError: kit.db: this kit has several databases. Read the one you mean, as `kit.databases.main`.

// TRANSACTION — several clients, and no `{ on }`.
await kit.transaction(async (tx) => { /* … */ });
// KitError: transaction: this kit holds more than one client, …

// DERIVED — closing a kit that `as` derived.
await kit.as(userId).close();
// KitError: close: this kit came from `as`, `withSession` or a transaction. …
```

A name no database has, and `{ on: 'nowhere' }` with it, do not compile
either: the types refuse them where they are written. The run-time refusal is
what catches the call that arrived through an `any`, or from JavaScript — and
`kit.db` on a kit with several databases, whose type is already `never`.

## A start-up that reports instead of crashing

The useful thing to do with a `KitError` is to say which database and which
key, because that is what the fix needs:

```ts
import { createKit, defineConfig, KitError } from '@nxgt/mongo-kit';
import * as collections from './models';

export async function startDatabase() {
	try {
		return await createKit(
			defineConfig({ uri: process.env.MONGO_URI!, collections }),
		);
	} catch (error) {
		if (error instanceof KitError) {
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

MongoDB's own refusal to connect is **not** a `KitError`: a host that does not
answer, a wrong password, a replica set with no primary are the driver's
errors, and they reach the caller unchanged from `createKit`. A database that
fails to open gives back every connection opened before it.

## Next

- [Configuration](configuration.md) — what `defineConfig` checks, key by key.
- [The `db` scope](db-scope.md) — `kit.db`, `kit.databases` and the names
  that are refused.
- [The actor, sessions and transactions](actor-and-transactions.md) — `{ on }`,
  and the kits that cannot be closed.
- [Troubleshooting](../troubleshooting.md) — the same errors, indexed by the
  message you are staring at.
