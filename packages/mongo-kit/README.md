# @nxgt/mongo-kit

An application's MongoDB in one object: a configuration checked once, the
clients it needs opened from it, and every collection of
[`@nxgt/mongo`](https://www.npmjs.com/package/@nxgt/mongo) typed on the
database it lives in.

```ts
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import * as collections from './models';   // every `defineCollection` of the app

export const kit = await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections }),
);

const user = await kit.db.users.create({ email: 'ada@example.com' });
const posts = await kit.db.posts.findMany({ filter: { authorId: user._id } });
await kit.db.command({ ping: 1 });         // the driver's Db, untouched
```

`kit.db` is the driver's `Db` with the collections on it: `db.users` is the
typed collection `getCollection(db, users)` gives, and everything a `Db`
answers to is still there. Nothing else has to be wired: no `getCollection`
at each call site, no client to pass around, no session to thread by hand.

> **0.x, on `@nxgt/mongo`.** The API is still settling.

## Install

```sh
bun add @nxgt/mongo-kit @nxgt/mongo mongodb zod
```

- `@nxgt/mongo`: required peer. The collections, their options and their
  behaviour are its; this package wires them.
- `mongodb` `>=7.0.0 <8`: required peer, as `@nxgt/mongo` needs it. `zod` is
  `@nxgt/mongo`'s.
- `typescript` 6: required peer, the version every `@nxgt` package pins.
- Tested against MongoDB 8.2. A **replica set** only for transactions, which
  is MongoDB's own rule.

## The collections

They come from a module object — one import, and every type follows:

```ts
// src/models/index.ts
export * from './users.model';
export * from './posts.model';

// src/db.ts
import * as collections from './models';
```

Each export that is a `defineCollection` becomes a key on the scope, under
the name it is exported by; anything else in the module — a function, a
constant, a type — is left where it is. The key is the name the application
reads (`db.users`), and the collection's own `name` is the one on the server,
so `export const users = defineCollection({ name: 'app_users', … })` is
`db.users` here and `app_users` there. Two exports on one server collection
are refused: two keys writing to the same place is a mistake, not a feature.

For a **script** — a sync or a migration run from the repository — the files
can be read from disk instead:

```ts
import { syncCollections } from '@nxgt/mongo';
import { discoverCollections } from '@nxgt/mongo-kit';

const definitions = await discoverCollections({ glob: 'src/**/*.model.ts' });
await syncCollections(db, definitions);     // `db` from connectMongo, say
```

It gives `@nxgt/mongo`'s `AnyCollectionDefinition[]`, **with no types**: a
glob is read at run time, so a bundler cannot follow it and the compiler sees
nothing. It **runs under Bun** — the glob is `Bun.Glob` — and it imports each
file it finds, so their top level runs. It is for scripts, never for the
wiring of an application.

## Several databases

They name themselves, and `kit.databases` reads them:

```ts
export const kit = await createKit(
	defineConfig({
		databases: {
			main: { uri: process.env.MONGO_URI!, collections },
			analytics: { uri: process.env.ANALYTICS_URI!, collections: events },
		},
	}),
);

await kit.databases.main.users.create({ email: 'ada@example.com' });
await kit.databases.analytics.events.create({ kind: 'signup' });
```

`kit.db` is then `never`: with two databases there is no “the” database, and
the name is what says which — and reading it anyway, from JavaScript or
across an `any`, throws. A single database is named `default`, so
`kit.databases.default` and `kit.clients.default` are the long way of writing
the same thing, and `sync()` reports under that key.

Two databases on one URI share one client, which is what `connectMongo`
already does; their `clientOptions` must then be identical, since the second
hold on a client opened with other options is refused.

## The actor and the session

```ts
await kit.as(userId).db.posts.create({ title: 'a' });   // stamps createdBy

await kit.as(userId).transaction(async (tx) => {
	const team = await tx.db.teams.create({ name: 'Core' });
	await tx.db.users.update(userId, { teamId: team._id });
});
```

`as` and `withSession` give back **another kit** over the same clients: the
one they came from is unchanged, so a request's kit never leaks into the
next. The collections are built on the first read and kept, so a request
pays for the collections it touches and no others.

`transaction` runs the body with a kit whose collections are all in the
session — nothing has to be passed. **The driver retries the body from the
start** on a transient error, so it must be safe to run twice: keep side
effects that are not MongoDB's out of it. A transaction inside a transaction
**joins** the outer one, and takes no `{ on }`, since the session already
decided; MongoDB has no savepoints, so an inner failure takes the whole
transaction with it.

With several clients, `{ on: 'main' }` says whose, since a transaction lives
on one client — and inside that body only the databases on that client can be
used: an operation on another one carries a session its client does not own,
and the driver refuses it.

The actor's type is the one the collections agree on: a kit whose collections
stamp an `ObjectId` takes an `ObjectId`, and one whose collections stamp
nothing has no `as` to call.

## Sync

```ts
const reports = await kit.sync();          // { main: [ … ], analytics: [ … ] }
await kit.sync({ dryRun: true });          // what it would change
```

The first database that throws stops the rest, which is what `dryRun` is for:
it reports everything at once. It syncs exactly the collections the kit
wires, database by database —
`@nxgt/mongo`'s `syncAll` cannot, since its registry knows no database. It is
a **deployment step**: `collMod` needs the `dbAdmin` role, and an index build
runs outside any transaction. For tests and development, `autoSync: true` in
the config syncs each collection before its first operation instead.

## Closing

```ts
await kit.close();                         // or `await using kit = await createKit(…)`
```

It gives back the clients it opened, and leaves alone a `client` the config
gave it: what it did not open is not its to close. Only the kit `createKit`
returned can be closed — one from `as`, `withSession` or a transaction shares
those clients and refuses.

## API

### `defineConfig(config)`

Checks the configuration and freezes it. It connects to nothing and reads no
environment variable: the application writes `uri: process.env.MONGO_URI!`,
and what is wrong throws here, where the application starts.

| Key | Default | |
| --- | --- | --- |
| `uri` | — | One of `uri` and `client`, never both. |
| `client` | — | A client the application opened. Never closed by the kit. |
| `clientOptions` | `{}` | Passed to the driver with `uri`. Refused with `client`. |
| `database` | the URI's, else `test` | The database's name. |
| `collections` | — | `import * as collections from './models'`. |
| `options` | `{}` | `@nxgt/mongo`'s collection options, for every collection. |
| `optionsFor` | `{}` | The same, per key, merged over `options`. |
| `autoSync` | `false` | Sync each collection before its first operation. |

`db`, `session`, `actor` and `autoSync` are not collection options here: the
kit decides them, and one of them under `options` does not compile, while one
under `optionsFor` is refused by `defineConfig` — the types cannot see that
deep. Several databases go under `databases: { main: …, … }`, each one taking
the same keys; a lone database is named `default`.

### `createKit(config)`

Opens what the configuration describes, and gives a `MongoKit`:

| Member | |
| --- | --- |
| `db` | The only database's scope; `never` with several, and it throws if read anyway. |
| `databases` | Every scope, under its name — `default` when the config named none. |
| `clients` | The `MongoClient` of each database, under the same names. |
| `actor`, `session` | What this kit stamps and runs in, if anything. |
| `as(actor)` | The same kit, stamping that actor. |
| `withSession(session)` | The same kit, in that session; `undefined` takes it away. |
| `transaction(fn, options?)` | `fn` with a kit in a transaction. May run twice. |
| `sync(options?)` | `SyncReport[]` per database, under its name. |
| `close()` | Gives back what it opened. Idempotent. |

`KitOf<typeof config>` is that kit's type, for an application that declares
it — a service holding the kit, say — rather than reading it off `await
createKit(…)`.

### `discoverCollections({ glob, cwd?, export? })`

The definitions of the files a glob matches, read at run time and untyped.
`cwd` is where the glob starts, `process.cwd()` by default. `export` reads
one export by name in each file, and throws for a matched file that has no
definition under it; without `export`, every export that is a definition is
taken. Two files defining the same server collection are refused. It needs
the Bun runtime, and it is for scripts.

## Errors

`KitError` is what this package refuses: a configuration, a name or a call
that cannot work. It carries a `code`, and the `database` and `key` it is
about — never a URI, which may hold a password.

```ts
import { KitError } from '@nxgt/mongo-kit';

if (error instanceof KitError && error.code === 'CONFIG') {
	console.error(`mongo: "${error.database}" is misconfigured`, error.message);
}
```

| `KitErrorCode` | |
| --- | --- |
| `CONFIG` | `defineConfig` refused the configuration |
| `COLLISION` | a collection is wired under a name the driver's `Db` has |
| `NO_DATABASE` | `transaction(fn, { on })` named a database this kit does not hold |
| `SEVERAL_DATABASES` | `kit.db` was read on a kit that holds more than one |
| `TRANSACTION` | no client named where one is needed, or `{ on }` inside a session |
| `DERIVED` | `close()` on a kit `as`, `withSession` or a transaction derived |
| `DISCOVERY` | `discoverCollections` could not make a set of definitions |

It extends **`TypeError`**, not `Error`: each of these is a call or a
configuration written wrong, and this package threw bare `TypeError`s before
the class existed, so a `catch` that tests for `TypeError` still matches.

The collections are `@nxgt/mongo`'s, so what a *query* throws is its
`DataError` and its subclasses, unchanged. MongoDB's own refusal to connect
reaches the caller from `createKit` as the driver's error. Every code, with
the call that raises it, is in
[docs/guide/errors.md](docs/guide/errors.md).

## What does not compile

Each is a `@ts-expect-error` case in this package's type tests.

- A collection wired under a name the driver's `Db` already has
  (`command`, `watch`, `collection`, …): it would be unreachable.
- `db.usrs`, or a field no schema has in a `create`.
- `kit.db` when the kit holds several databases, `kit.databases.nowhere`,
  or `{ on: 'nowhere' }`.
- `optionsFor` under a key no collection is wired under.
- `session`, `db`, `actor` or `autoSync` under `options`. Under
  `optionsFor`, the same four are refused by `defineConfig` instead.
- `as` with an actor of the wrong type, and `as` at all when the
  collections stamp none or disagree.

## Traps

- **A key the driver's `Db` has is refused twice**: by the types where the
  config is written, and by `createKit` against the object itself — which is
  what catches a member a later driver release adds.
- **The scope is a `Db` underneath.** `Object.keys(kit.db)` lists the
  collections, not the driver's members; a driver method read off it is
  bound, so `const { command } = kit.db` works.
- **`createKit` connects.** `defineConfig` does not, so a wrong URI throws
  where the kit is created, and a database that fails gives back every
  connection opened before it.
- **A client the config gave is never closed**, including by `await using`.
  Close it where it was opened.
- **`autoSync` is for tests and development.** In production `sync()` is a
  deployment step: it needs `dbAdmin`, and an index build is not in a
  transaction.
- **A kit from `as` or `withSession` cannot be closed**, and `close()` on it
  throws `KitError` with the code `DERIVED`: the clients are the root kit's.
- **`discoverCollections` runs under Bun**, has no types, and does not
  survive bundling. It is for scripts run from the repository; a Node script
  calling it gets `Bun is not defined`.
- **Two collections that stamp actors of different types** leave `as`
  uncallable: one call could not stamp both.
- **`{ on }` is required at run time, not by the types**, and cannot be: two
  databases on one URI share a client and need none, so what decides is the
  number of *clients*. Without it, a kit holding two throws `TRANSACTION`.
- **A transaction body may run twice.** The driver retries it from the start
  on a transient error, so it must hold nothing that MongoDB would not roll
  back.
- **A transaction reaches one client's databases.** With `{ on: 'main' }`,
  an operation on a database of another client carries a session that client
  does not own, and the driver refuses it.
- **`kit.db` throws `SEVERAL_DATABASES` on a kit with several databases**,
  where its type is already `never`: the message names the databases to read
  instead.

## Documentation

- [Guide index](docs/README.md) — every page, and when to read it.
- [Configuration](docs/guide/configuration.md) — the databases, the
  collections, and the options each is built with.
- [The `db` scope](docs/guide/db-scope.md) — the collections on the driver's
  `Db`, and the kit in a request.
- [The actor, sessions and transactions](docs/guide/actor-and-transactions.md)
  — `as`, `withSession` and `transaction`.
- [Syncing](docs/guide/sync.md) — the deployment step, and `dryRun`.
- [Errors](docs/guide/errors.md) — `KitError`, its codes, and what each one
  is thrown by.
- [`discoverCollections`](docs/guide/discover-collections.md) — definitions
  from a glob, for scripts.
- [Troubleshooting](docs/troubleshooting.md) — the errors, by their message.
- [Roadmap](docs/roadmap.md) — what is next, and what is not planned.

## License

MIT
