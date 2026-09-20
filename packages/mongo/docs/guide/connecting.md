# Connecting

`connectMongo` is a convenience over `MongoClient`: one client per URI, a
`ping` that never throws, and a close that waits for the last holder. A
client you open yourself works everywhere too.

```ts
import { closeMongo, connectMongo, getCollection } from '@nxgt/mongo';
import { users } from './collections';

const mongo = await connectMongo(process.env.MONGO_URL, { appName: 'api' });
const collection = getCollection(mongo.db, users);

await mongo.close();     // or `await using mongo = await connectMongo(…)`
```

`mongo.db` is the URI's database — `test` when the URI names none, the
driver's own default. `mongo.client` is the `MongoClient`, which is what
[`withTransaction`](transactions.md) starts a session from.

## One client per URI

Every `connectMongo` with the same URI shares a `MongoClient`, connected once
even when the calls race. Each call gets its own connection; the client
closes when the last one is closed, so a module that closes its own does not
cut the others off.

```ts
const a = await connectMongo(uri);
const b = await connectMongo(uri);
a.client === b.client;   // true
await a.close();         // b still works
await b.close();         // now the client is closed
```

- **Same options everywhere.** A second call with other options for a
  connected URI throws; the message does not repeat the URI, which may hold a
  password. Options are compared by value — a `serverApi` built again at each
  call is the same — except functions and class instances, which must be the
  same object. What the first call passed is kept, so changing that object
  afterwards changes nothing.
- **A failed connect is forgotten**, so calling again tries again.
- `closeMongo()` closes every client, whoever still holds one — the end of a
  process, or of a test file. **Nothing listens to signals for you.**

```ts
process.on('SIGTERM', async () => {
	await subscription?.close();
	await closeMongo();
});
```

**Close a shared client through its connection.** `mongo.client.close()`
skips the count: the closed client stays shared, and every later
`connectMongo` for that URI gets it, dead, until `closeMongo()`.

## A health check

`ping` answers within `timeoutMS` either way, and never throws — a health
check reports, it does not fail.

```ts
app.get('/health', async (c) => {
	const result = await mongo.ping({ timeoutMS: 500 });
	if (!result.ok) log.warn(result.error);   // the error names the hosts: keep it in a log
	return c.json({ ok: result.ok, latencyMs: result.ok ? result.latencyMs : undefined });
});
```

```ts
type PingResult =
	| { readonly ok: true; readonly latencyMs: number }
	| { readonly ok: false; readonly error: unknown };
```

## Start-up, in order

```ts
import { closeMongo, connectMongo, syncAll } from '@nxgt/mongo';
import { migrate } from '@nxgt/mongo/migrations';
import { migrations } from './migrations';
import './collections';

const mongo = await connectMongo(process.env.MONGO_URL);

// A deployment step, with a credential that has dbAdmin — not every boot:
if (process.env.RUN_SYNC === '1') {
	await syncAll(mongo.db);
	await migrate(mongo.db, migrations);
}

export const db = mongo.db;
export const shutdown = () => closeMongo();
```

[`sync`](sync.md) and [`migrate`](migrations.md) are deployment steps:
`collMod` needs `dbAdmin`, and a migration takes a lock. An application whose
user is `readWrite` runs neither.

## In tests

Transactions and [change streams](changes.md) need a replica set, which a
standalone `mongod` is not. This package's own specs run against a
single-node replica set from `mongodb-memory-server-core`, with no Docker;
the same works in a consumer's test suite.

```ts
import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { MongoClient } from 'mongodb';
import { getCollection, resetAutoSync } from '@nxgt/mongo';
import { users } from './collections';

let server: MongoMemoryReplSet;
let client: MongoClient;

beforeAll(async () => {
	server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
	client = await MongoClient.connect(server.getUri());
}, 120_000);

beforeEach(async () => {
	await client.db('test').dropDatabase();
	resetAutoSync();          // the memo of what autoSync created goes with it
});

afterAll(async () => {
	await client.close();
	await server.stop();
});

const collection = () =>
	getCollection(client.db('test'), users, { autoSync: true });
```

`autoSync` is what makes a test skip the deployment step; `resetAutoSync()`
is what keeps a dropped database honest. A bucket has
[`resetBucketSync()`](gridfs.md#create-the-indexes) beside it.

## The signatures

```ts
function connectMongo(uri: string, options?: MongoClientOptions): Promise<MongoConnection>;
function closeMongo(): Promise<void>;

interface MongoConnection extends AsyncDisposable {
	readonly client: MongoClient;
	/** The URI's database, or `test` when the URI names none. */
	readonly db: Db;
	/** Sends `ping`, and answers within `timeoutMS` (default 2 s) either way. */
	ping(options?: { timeoutMS?: number }): Promise<PingResult>;
	/** Idempotent. The client closes when the last connection to it does. */
	close(): Promise<void>;
}
```

A connect that `closeMongo()` interrupts rejects: at shutdown, a request
still connecting fails rather than getting a closed client.

## Next

- [Documents](documents.md) — the collection you bind to `mongo.db`.
- [Sync](sync.md) — what to run before the first request.
