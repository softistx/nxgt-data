# Troubleshooting

Every heading is the text the error prints, so the page can be searched with
what you have in front of you. Stacks, ids and paths are cut.

Everything this package refuses is a `KitError`, exported from
`@nxgt/mongo-kit`. It carries a `code` — `CONFIG`, `COLLISION`,
`NO_DATABASE`, `SEVERAL_DATABASES`, `TRANSACTION`, `DERIVED` or `DISCOVERY` —
beside the `database` and the `key` it is about, so a caller switches on the
code instead of matching the sentence. It extends `TypeError`, which these
were before 0.2.0, so a `catch` written against `TypeError` still catches
them. The driver's own errors, and `@nxgt/mongo`'s `DataError`s, reach you
unchanged.

```ts
import { KitError } from '@nxgt/mongo-kit';

try {
	await kit.transaction(work, { on: 'main' });
} catch (error) {
	if (error instanceof KitError) {
		log.error({ code: error.code, database: error.database, key: error.key });
	}
	throw error;
}
```

| Area | Entries |
| --- | --- |
| [Install](#install) | [ERESOLVE](#npm-error-eresolve-unable-to-resolve-dependency-tree) · [incorrect peer dependency](#warn-incorrect-peer-dependency-nxgtmongo0140) · [TS2307](#error-ts2307-cannot-find-module-nxgtmongo-or-its-corresponding-type-declarations) |
| [Types](#types) | [a key the `Db` has](#command-is-a-member-of-the-drivers-db-wire-this-collection-under-another-key) · [options for a key that is not wired](#posts-is-not-wired-by-this-database-there-are-no-options-for-it) · [a bucket under a key the `Db` has](#watch-is-a-member-of-the-drivers-db-wire-this-bucket-under-another-key) · [a bucket under a collection's key](#users-is-also-a-collection-of-this-database-wire-this-bucket-under-another-key) · [a bucket option the kit decides](#autosync-is-the-kits-to-decide-withsession-and-transactions-carry-the-session-and-autosync-is-the-databases) |
| [Configuration](#configuration) | [no configuration at all](#defineconfig-a-configuration-object-is-required) · [`databases` is not an object of databases by name](#defineconfig-databases-must-be-an-object-of-databases-by-name-as--databases--main----one-database-is-the-configuration-itself-and-names-itself-with-database) · [neither a uri nor a client](#defineconfig-database-main-has-neither-a-uri-nor-a-client) · [both](#defineconfig-database-main-has-both-a-uri-and-a-client-pass-the-one-it-should-use) · [client options](#defineconfig-database-main-has-client-options-beside-a-client-it-did-not-open-pass-them-where-the-client-is-made) · [no definition in it](#defineconfig-database-main-has-a-collections-object-with-no-definition-in-it-pass-the-module-as-in-import--as-collections) · [two keys, one collection](#defineconfig-database-main-wires-users-and-people-to-the-same-collection-users) · [an option the kit decides](#defineconfig-database-main-has-session-in-options-which-the-kit-decides-) · [options for a key it does not wire](#defineconfig-database-main-has-options-for-posts-which-it-does-not-wire) · [no databases](#defineconfig-databases-names-none-give-it-at-least-one-as--databases--main---) · [no bucket in `buckets`](#defineconfig-database-main-has-a-buckets-object-with-no-bucket-definition-in-it-pass-the-module-as-in-import--as-buckets) · [a key both a collection and a bucket](#defineconfig-database-main-wires-users-as-both-a-collection-and-a-bucket-export-one-of-them-under-another-name) · [two keys, one bucket](#defineconfig-database-main-wires-avatars-and-pictures-to-the-same-bucket-avatars) · [a bucket option the kit decides](#defineconfig-database-main-has-session-in-bucketoptions-which-the-kit-decides-) |
| [Runtime](#runtime) | [a key the `Db` has, at creation](#createkit-database-main-wires-a-collection-under-command-which-is-a-member-of-the-drivers-db-it-would-be-unreachable-export-that-definition-under-another-name) · [a bucket key the `Db` has, at creation](#createkit-database-main-wires-a-bucket-under-watch-which-is-a-member-of-the-drivers-db-it-would-be-unreachable-export-that-definition-under-another-name) · [ECONNREFUSED](#mongoserverselectionerror-connect-econnrefused-12700127017) · [one URI, two option sets](#connectmongo-this-uri-is-already-connected-with-other-options-pass-the-same-options-everywhere-or-close-the-first-connection) · [`kit.db` with several databases](#kitdb-this-kit-has-several-databases-read-the-one-you-mean-as-kitdatabasesmain) · [an unknown database](#this-kit-has-no-database-reporting-it-has-main-analytics) · [closing a derived kit](#close-this-kit-came-from-as-withsession-or-a-transaction-close-the-kit-createkit-returned--the-clients-are-shared) · [`sync()` and privileges](#not-authorized-on-app-to-execute-command--collmod-users--) |
| [Transactions](#transactions) | [more than one client](#transaction-this-kit-holds-more-than-one-client-and-a-transaction-lives-on-one-name-the-database-it-runs-on-as--on-main-) · [already in a session](#transaction-this-kit-is-already-in-a-session-which-this-call-joins-so-on-has-no-client-left-to-choose) · [a session from another client](#clientsession-must-be-from-the-same-mongoclient) · [no replica set](#this-mongodb-deployment-does-not-support-retryable-writes-please-add-retrywritesfalse-to-your-connection-string) |
| [Scripts](#scripts) | [`Bun is not defined`](#referenceerror-bun-is-not-defined) · [no glob](#discovercollections-a-glob-is-required) · [two files, one collection](#discovercollections-srcmodelsonemodelts-and-srcmodelstwomodelts-both-define-the-collection-twice) · [no definition of that name](#discovercollections-srcmodelsnotests-exports-no-definition-named-definition) |

## Install

### `npm error ERESOLVE unable to resolve dependency tree`

```
npm error Found: @nxgt/mongo@0.14.0
npm error Could not resolve dependency:
npm error peer @nxgt/mongo@"^0.15.0" from @nxgt/mongo-kit@0.1.4
```

**When:** `npm install`, before anything is downloaded.

**Why:** `@nxgt/mongo` is a **required peer**, and the range is a caret on a
0.x version, so it accepts one minor only. The collections, their options and
their behaviour are `@nxgt/mongo`'s; this package only wires them, and the two
have to be the same copy. `mongodb` (`>=7.0.0 <8`) and `typescript` (`^6.0.3`)
are peers on the same terms.

**Fix:**

```sh
npm install @nxgt/mongo@^0.15.0 @nxgt/mongo-kit mongodb zod
```

Raise the sibling rather than install past the conflict: `--force` and
`--legacy-peer-deps` leave two copies of `@nxgt/mongo` in the tree, and the
definitions one of them builds are not the ones the other wires.

### `warn: incorrect peer dependency "@nxgt/mongo@0.14.0"`

**When:** `bun install`, which prints it and carries on.

**Why:** bun does not fail on an unmet peer — it warns and installs what the
manifest asked for. The kit then runs against a `@nxgt/mongo` it was not built
against: a stamp option or a collection option added in the newer minor is
missing at run time, with no error until the call that needs it.

**Fix:**

```sh
bun add @nxgt/mongo@^0.15.0
```

Treat that warning as an error. `bun pm ls` shows which version was resolved.

### `error TS2307: Cannot find module '@nxgt/mongo' or its corresponding type declarations.`

At run time the same tree gives
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@nxgt/mongo'` under Node,
and `error: Cannot find module '@nxgt/mongo'` under Bun.

**When:** the first build or the first import of your own code, typically
under pnpm or npm with a strict `node_modules` layout.

**Why:** a peer installed *for* the kit is not a dependency of **your**
package. pnpm hoists it under the kit alone, so `@nxgt/mongo-kit` resolves it
and your `import { defineCollection } from '@nxgt/mongo'` does not.

**Fix:**

```sh
bun add @nxgt/mongo @nxgt/mongo-kit mongodb zod
```

Declare every peer you import from yourself — you import `@nxgt/mongo` as soon
as you write a `defineCollection`.

## Types

### `"command" is a member of the driver's Db: wire this collection under another key`

The whole line is a `TS2322`:

```
error TS2322: Type 'CollectionDefinition<…>' is not assignable to type
'CollectionDefinition<…> & "\"command\" is a member of the driver's Db: wire this collection under another key"'.
```

**When:** compiling the file that calls `defineConfig`.

**Why:** `kit.db` is the driver's `Db` with the collections on it, so a key the
`Db` already answers to — `command`, `watch`, `collection`, `admin`,
`databaseName`… — would be unreachable, and reading it would give the driver's
member instead of your collection. The reserved names are read from the
driver's own type (`ReservedName = keyof Db`), so a member a later driver
release adds is refused the day the pin moves.

**Fix:** export the definition under another name.

```ts
// src/models/commands.model.ts
export const commandLog = defineCollection({ name: 'commands', schema });
//           ^ the key on `kit.db`; `name` is the collection on the server
```

The key is the **export name**, not the collection's `name`: only the export
name has to change.

### `"posts" is not wired by this database: there are no options for it`

**When:** compiling a `defineConfig` whose `optionsFor` names a key its
`collections` does not hold.

**Why:** `optionsFor` is keyed by the same export names as `collections`, and
options written for a key that is not wired would silently do nothing —
usually a renamed or moved model.

**Fix:**

```ts
defineConfig({
	uri: process.env.MONGO_URI!,
	collections,                       // `import * as collections from './models'`
	optionsFor: { articles: { maxPageSize: 200 } },  // a key `collections` exports
});
```

### `"watch" is a member of the driver's Db: wire this bucket under another key`

**When:** compiling a `defineConfig` whose `buckets` exports a bucket under
a name the driver's `Db` answers to.

**Why:** a bucket sits on the scope beside the collections, so it has the
same problem as a
[collection under such a key](#command-is-a-member-of-the-drivers-db-wire-this-collection-under-another-key):
`kit.db.watch` would be the driver's method, never your bucket.

**Fix:** export it under another name. The export name is the key; the
bucket's `name` is what the server sees, and need not change.

```ts
// src/files/index.ts
export const watchClips = defineBucket({ name: 'watch' });
```

### `"users" is also a collection of this database: wire this bucket under another key`

**When:** compiling a `defineConfig` whose `buckets` and `collections`
export something under the same name.

**Why:** both would be `kit.db.users`. Usually one module of models and one
of files that grew the same export name, or one module passed as both.

**Fix:** rename one of the two exports.

```ts
export const userPhotos = defineBucket({ name: 'users' });
//           ^ the key on `kit.db`: `kit.db.users` stays the collection
```

### `"autoSync" is the kit's to decide: withSession and transactions carry the session, and autoSync is the database's`

The same message names `"session"` when that is the key at fault.

**When:** compiling a `defineConfig` whose `bucketOptions` holds `session`
or `autoSync`.

**Why:** a bucket takes its session from the kit — `withSession`, or the
transaction a `kit.transaction` body runs in — and its `autoSync` from the
database. Pinned in the config, either would outrank the kit, and a file
would be written outside the transaction around it.

**Fix:**

```ts
defineConfig({
	uri: process.env.MONGO_URI!,
	collections,
	buckets,
	autoSync: true,                    // the database's, for tests and development
	bucketOptions: { hash: false },    // only validate, coerce and hash
});
```

## Configuration

`defineConfig` connects to nothing: everything below is a `KitError` with
`code: 'CONFIG'`, thrown where the configuration is written, before the
application starts. It names the database it is about as `error.database`,
and the collection key as `error.key` when one is at fault.

### `defineConfig: a configuration object is required`

**When:** calling `defineConfig` with nothing, `undefined` or `null` — usually
a config read from a module that exports it under another name, or a value
built at run time that came out empty.

**Why:** the configuration is read as an object before anything else is
checked, so there is nothing to name a database with. A `defineConfig(config)`
where `config` is `undefined` is most often an import that resolved to
`undefined`: a default export read as a named one, or two modules importing
each other, so one of them is still empty when the other runs.

**Fix:** write the config as a literal, where the compiler sees its shape:

```ts
import * as collections from './models';

export const config = defineConfig({ uri, collections });
```

### ``defineConfig: databases must be an object of databases by name, as `{ databases: { main: … } }`. One database is the configuration itself, and names itself with `database`.``

**When:** calling `defineConfig` with a `databases` that is a string, a number
or `null`.

**Why:** `databases` is the multi-database shape, and its **keys** are the
names — `databases: 'main'` looks like naming the one database, which is what
`database` does. A single database says `database`, several say `databases`.

**Fix:**

```ts
defineConfig({ uri, database: 'analytics', collections });      // one database
defineConfig({ databases: { main: { uri, collections } } });    // several
```

`database` is the database on the server; the key under `databases` is the
name your code reads it by, as `kit.databases.main`.

### `defineConfig: database "main" has neither a uri nor a client`

**When:** calling `defineConfig`.

**Why:** a database says where it is exactly once. This is most often an
environment variable that was not read — `process.env.MONGO_URI` is
`undefined`, so the property is absent.

**Fix:**

```ts
const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is not set');
export const config = defineConfig({ uri, collections });
```

### `defineConfig: database "main" has both a uri and a client: pass the one it should use`

**When:** calling `defineConfig`.

**Why:** the two mean different things about closing: with a `uri` the kit
opens the client and `close()` gives it back, with a `client` it uses yours and
never closes it. It will not guess which you meant.

**Fix:**

```ts
defineConfig({ client, database: 'main', collections });  // yours to close
```

### `defineConfig: database "main" has client options beside a client it did not open: pass them where the client is made`

**When:** calling `defineConfig` with both `client` and `clientOptions`.

**Why:** `clientOptions` is what the kit passes to the driver when it opens a
client. A client that is already open cannot take them, so they would be
ignored.

**Fix:**

```ts
const client = new MongoClient(uri, { maxPoolSize: 50 }); // here
defineConfig({ client, collections });
```

### `` defineConfig: database "main" has a collections object with no definition in it: pass the module, as in `import * as collections` ``

**When:** calling `defineConfig`.

**Why:** the object holds no value that looks like a `defineCollection` —
usually a module of *types* only, a default export, or a barrel whose files
export builders rather than definitions.

**Fix:**

```ts
// src/models/index.ts
export * from './users.model';   // `export const users = defineCollection(…)`
export * from './posts.model';

// src/db.ts
import * as collections from './models';
defineConfig({ uri, collections });
```

Anything in that module that is not a definition — a function, a constant, a
type — is left out of the scope rather than refused.

### `defineConfig: database "main" wires "users" and "people" to the same collection, "users"`

**When:** calling `defineConfig`.

**Why:** two exports carry definitions with the same `name`, so two keys on
`kit.db` would write to one server collection with two schemas and two sets of
options. Usually a copy-and-pasted model whose `name` was not changed.

**Fix:**

```ts
export const people = defineCollection({ name: 'people', schema });
//                                       ^ one `name` per collection
```

### `defineConfig: database "main" has "session" in options, which the kit decides: …`

The full message names what to use instead:

```text
defineConfig: database "main" has "session" in options, which the kit decides:
a database is named by its key, `as` and `withSession` carry the actor and the
session, and `autoSync` is the database's
```

The same refusal covers `db`, `actor` and `autoSync`, in `options` and under
`optionsFor` — where the text reads `has "session" in the options of "users"`.

**When:** calling `defineConfig`.

**Why:** those four are the kit's. A `session` pinned in the config would
outrank the one a transaction hands the collection, and the write would land
outside the transaction.

**Fix:**

```ts
const kit = await createKit(config);
await kit.transaction(async (tx) => {   // the session is the kit's
	await tx.db.users.create({ email: 'ada@example.com' });
});
```

`autoSync` belongs to the database, beside `collections`, not to a collection's
options.

### `defineConfig: database "main" has options for "posts", which it does not wire`

**When:** calling `defineConfig`, when the types were bypassed — an `as never`,
a config built at run time, or JavaScript.

**Why:** the same cause as the type error
[above](#posts-is-not-wired-by-this-database-there-are-no-options-for-it):
`optionsFor` names a key `collections` does not export.

**Fix:** write the config as a literal, so the compiler refuses it first:

```ts
export const config = defineConfig({ uri, collections, optionsFor: { users: {} } });
```

### ``defineConfig: databases names none. Give it at least one, as `{ databases: { main: … } }`.``

**When:** calling `defineConfig` with `databases: {}`.

**Why:** the multi-database shape was used and the object came out empty —
typically built from environment variables that were not set.

**Fix:**

```ts
defineConfig({ databases: { main: { uri, collections } } });
```

### `` defineConfig: database "main" has a buckets object with no bucket definition in it: pass the module, as in `import * as buckets` ``

**When:** calling `defineConfig` with a `buckets` that holds no
`defineBucket` — or that is not an object at all.

**Why:** a bucket is told by its shape, and nothing in the object had it.
Usually the collections passed as `buckets` by mistake, a module of types
only, or a default export.

**Fix:**

```ts
// src/files/index.ts
export const avatars = defineBucket({ name: 'avatars' });

// src/db.ts
import * as buckets from './files';
defineConfig({ uri, collections, buckets });
```

Leave `buckets` out when the database has none; an empty object is refused.

### `defineConfig: database "main" wires "users" as both a collection and a bucket: export one of them under another name`

**When:** calling `defineConfig`, when the types were bypassed — an
`as never`, a config built at run time, or JavaScript.

**Why:** the same cause as the
[type error](#users-is-also-a-collection-of-this-database-wire-this-bucket-under-another-key):
two exports would both be `kit.db.users`. `error.key` is the key.

**Fix:** rename one export, as above.

### `defineConfig: database "main" wires "avatars" and "pictures" to the same bucket, "avatars"`

**When:** calling `defineConfig`.

**Why:** two exports carry buckets with the same `name`, so two keys on
`kit.db` would write to one pair of server collections, `avatars.files` and
`avatars.chunks`, perhaps with two metadata schemas. Usually a
copy-and-pasted `defineBucket` whose `name` was not changed.

**Fix:**

```ts
export const pictures = defineBucket({ name: 'pictures' });
//                                     ^ one `name` per bucket
```

### `defineConfig: database "main" has "session" in bucketOptions, which the kit decides: …`

The full message:

```text
defineConfig: database "main" has "session" in bucketOptions, which the kit
decides: `withSession` and transactions carry the session, and `autoSync` is
the database's
```

It reads `has "autoSync" in bucketOptions` for the other one.

**When:** calling `defineConfig`, when the types were bypassed.

**Why:** the same cause as the
[type error](#autosync-is-the-kits-to-decide-withsession-and-transactions-carry-the-session-and-autosync-is-the-databases):
a session pinned for every bucket would put file writes outside the
transaction around them.

**Fix:** take it out, and set `autoSync` on the database beside
`collections` if you want it.

## Runtime

### `createKit: database "main" wires a collection under "command", which is a member of the driver's Db: it would be unreachable. Export that definition under another name.`

**When:** `await createKit(config)`, and the connections opened before it are
given back before it throws.

**Why:** the same collision as the
[type error](#command-is-a-member-of-the-drivers-db-wire-this-collection-under-another-key),
asked of the live `Db` object rather than of its type. A `KitError` with
`code: 'COLLISION'`, carrying the `database` and the `key` it refused. It
fires when the types were bypassed, and when a driver release adds a member
your key already uses.

**Fix:** rename the export, as above. If the driver added the member, raising
`mongodb` is what surfaced it — the check is deliberate, not a regression.

### `createKit: database "main" wires a bucket under "watch", which is a member of the driver's Db: it would be unreachable. Export that definition under another name.`

**When:** `await createKit(config)`, with the connections opened before it
given back.

**Why:** the bucket form of the collision above, asked of the live `Db`:
the types refuse it
[where the config is written](#watch-is-a-member-of-the-drivers-db-wire-this-bucket-under-another-key),
and this catches the config that bypassed them, or a member a later driver
adds. `code: 'COLLISION'`, with the `database` and the `key`.
`defineConfig` cannot ask it: it has no `Db` until `createKit` connects.

**Fix:** rename the export.

```ts
export const watchClips = defineBucket({ name: 'watch' });
```

### `MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017`

**When:** `await createKit(config)` — never at `defineConfig`.

**Why:** `defineConfig` connects to nothing; `createKit` is the one call that
opens clients. A wrong URI, a server that is not up, or an unreachable host
therefore fails at start-up, not at the first query.

**Fix:** check the connection where the application starts, and let it fail
there:

```ts
export const kit = await createKit(config);   // top level: a bad URI stops the boot
```

### `ping: no answer in 2000ms`

**When:** the `error` of a `{ ok: false }` that `kit.ping()` reported, never
a throw.

**Why:** a database the configuration handed a `client` did not answer within
`timeoutMS`. Only such a database reports this: the kit races a timer of its
own for it, because a client that was never connected makes its connect on
the first command, and that connect waits `serverSelectionTimeoutMS`, not
`timeoutMS` (measured on mongodb 7.6.0). A database the kit opened from a
`uri` is always connected, and reports the driver's own error instead —
`MongoOperationTimeoutError` for a server that is too slow.

**Fix:** answer 503 and look at the server. If the database is a `client` you
handed over, connect it before `createKit`:

```ts
const client = await new MongoClient(uri).connect();
```

### `MongoTopologyClosedError: Topology is closed`

**When:** every command on a database the configuration gave a `client`, and
every `ping` of it, after one failure — at once, with no retry.

**Why:** the client was handed over unconnected, its first command made the
connect, and the connect failed. Measured on mongodb 7.6.0, the driver then
closes that client for good, so the server coming back changes nothing.

**Fix:** connect the client yourself before handing it over, so a server that
is down fails where the application starts, and a client that connected
reconnects on its own afterwards:

```ts
const client = await new MongoClient(uri).connect();
export const kit = await createKit(defineConfig({ client, collections }));
```

### `connectMongo: this URI is already connected with other options. Pass the same options everywhere, or close the first connection.`

**When:** `createKit`, or a second `createKit` in the same process.

**Why:** `@nxgt/mongo` shares one client per URI, and a shared client can only
have one set of options. Two databases on one URI with different
`clientOptions` — or a test that builds a second kit with other options —
ask for two.

**Fix:** give the same options on that URI, and name the databases instead:

```ts
defineConfig({
	databases: {
		main: { uri, database: 'main', collections },
		analytics: { uri, database: 'analytics', collections: events },
	},
});
```

Both databases then share the one client, which is the point.

### ``kit.db: this kit has several databases. Read the one you mean, as `kit.databases.main`.``

**When:** reading `kit.db` on a kit built from a `databases` config.

**Why:** `db` is the sole database's scope. With several there is no sole one,
so its type is already `never` — this is what a cast or a JavaScript call-site
gets at run time. `code: 'SEVERAL_DATABASES'`.

**Fix:**

```ts
await kit.databases.main.users.create({ email: 'ada@example.com' });
```

### `This kit has no database "reporting": it has "main", "analytics".`

**When:** `transaction(fn, { on })` with a name the config does not hold.

**Why:** the names are the keys of `databases` in the config, nothing else —
not the database names on the server. `code: 'NO_DATABASE'`, with the name
that was asked for as `error.database`. (Reading `kit.databases.<name>` for a
name that is not there does not throw: it does not compile, and gives
`undefined` where the types were bypassed.)

**Fix:**

```ts
await kit.transaction(fn, { on: 'main' });   // a key of `config.databases`
```

### ``close: this kit came from `as`, `withSession` or a transaction. Close the kit `createKit` returned — the clients are shared.``

**When:** `close()` — including the implicit one of `await using` — on a kit
that came from `as`, `withSession`, or the one handed to a transaction body.

**Why:** a derived kit shares the databases and the clients of the kit
`createKit` returned. Closing it would take the connections from every other
kit derived from the same root. `code: 'DERIVED'`.

**Fix:** keep `await using` for the root, and let the derived ones fall away:

```ts
await using kit = await createKit(config);   // the only one to close
const actorKit = kit.as(userId);             // no close, nothing to give back
```

### `not authorized on app to execute command { collMod: "users", … }`

**When:** `kit.sync()`, or the first operation of a collection when
`autoSync: true`.

**Why:** applying a `$jsonSchema` validator and the collection options is
`collMod`, which needs `dbAdmin`; `readWrite` alone is enough for the indexes
and every data operation but not for that.

**Fix:** run `sync()` as a deployment step, with a user that has `dbAdmin`, and
leave the application's own user on `readWrite`:

```ts
// scripts/sync.ts — run with the migration user, not the app's
await using kit = await createKit(config);
await kit.sync();
```

`autoSync` is for tests and development for the same reason.

## Transactions

### ``transaction: this kit holds more than one client, and a transaction lives on one. Name the database it runs on, as `{ on: 'main' }`.``

**When:** `kit.transaction(fn)` on a kit whose databases are on more than one
client.

**Why:** a transaction lives on a single client, and the types cannot decide:
two databases on one URI share a client and need no `on`, so what matters is
the number of *clients*, which is known only once they are open.
`code: 'TRANSACTION'`.

**Fix:**

```ts
await kit.transaction((tx) => tx.databases.main.users.create(user), { on: 'main' });
```

### ``transaction: this kit is already in a session, which this call joins, so `on` has no client left to choose.``

**When:** `transaction({ on })` inside a transaction body, or on a kit from
`withSession`.

**Why:** a nested transaction **joins** the outer one rather than opening a
second beside it, so it runs on the session that is already open — there is no
client left to pick. `code: 'TRANSACTION'`, as above.

**Fix:**

```ts
await kit.transaction(async (tx) => {
	await service(tx);            // its own `tx.transaction(fn)` joins this one
}, { on: 'main' });               // `on` belongs to the outermost call
```

### `ClientSession must be from the same MongoClient`

A `MongoInvalidArgumentError`, from the driver.

**When:** inside a transaction body, touching a database that is on another
client than the one the transaction runs on.

**Why:** a transaction reaches the databases of **one** client. With
`{ on: 'main' }`, an operation on a database of a second client carries a
session that client does not own, and the driver refuses it.

**Fix:** put the two databases on one client, or write two transactions and
accept that they do not commit together:

```ts
await kit.transaction((tx) => tx.databases.main.users.create(user), { on: 'main' });
await kit.databases.analytics.events.create({ kind: 'signup' }); // outside it
```

### `This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.`

**When:** the first `kit.transaction(…)` against a standalone `mongod`.

**Why:** the message is the driver's, and it is misleading: transactions need a
**replica set**, and a standalone has no transactions with or without retryable
writes. Turning `retryWrites` off does not help.

**Fix:** run a replica set — a single node is enough, and is what this
package's own specs use:

```sh
mongod --replSet rs0 --dbpath ./data   # then, once: rs.initiate()
```

## Scripts

`discoverCollections` is for scripts run from the repository: it reads a glob
from the file system, gives no types, and does not survive bundling. What it
refuses is a `KitError` with `code: 'DISCOVERY'`, and the path it was reading
as `error.key`.

### `ReferenceError: Bun is not defined`

**When:** calling `discoverCollections` from a script run by Node.

**Why:** the glob is `Bun.Glob`. This one function needs the Bun runtime;
everything else in the package runs anywhere.

**Fix:** run the script with Bun, or wire the collections statically — which is
what an application does anyway:

```ts
import * as collections from './models';    // a bundler follows this, Bun.Glob is not needed
```

### `discoverCollections: a glob is required`

**When:** running the script, with `glob` empty or absent — typically an
argument the script was not given, or an environment variable that is unset.

**Why:** the glob is the only thing that says which files to read. An empty
one matches nothing, and a discovery that came back empty would sync no
collection at all without saying so, so it is refused instead.

**Fix:** give the option a default the script can run with:

```ts
const glob = process.argv[2] ?? 'src/models/*.model.ts';
const definitions = await discoverCollections({ glob });
```

### `discoverCollections: src/models/one.model.ts and src/models/two.model.ts both define the collection "twice"`

**When:** running the script, while reading the files the glob matched.

**Why:** two matched files export definitions with the same collection `name`.
A sync driven from them would apply two schemas to one server collection.

**Fix:** give each collection its own `name`, or narrow the glob so only the
files you mean are read:

```ts
await discoverCollections({ glob: 'src/models/*.model.ts' });
```

### `discoverCollections: src/models/notes.ts exports no definition named "definition"`

**When:** running the script with the `export` option set.

**Why:** `export` names the single export to read in each matched file, and one
of them does not have it — or has it under that name holding something that is
not a definition.

**Fix:** drop the option and let every definition in each file be read, which
is what `import * as collections` gives:

```ts
await discoverCollections({ glob: 'src/models/*.model.ts' });
```
