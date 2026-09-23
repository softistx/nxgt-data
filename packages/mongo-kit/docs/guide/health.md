# Health

`kit.ping()` asks every database the kit wires whether it answers, at once,
and reports each under its name. It is written for a health endpoint: it
never throws, and it answers within its deadline whatever the servers do.

```ts
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import * as collections from './models';

export const kit = await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections }),
);

app.get('/health', async (c) => {
	const databases = await kit.ping({ timeoutMS: 1_000 });
	const up = Object.values(databases).every((result) => result.ok);
	return c.json(
		Object.fromEntries(
			Object.entries(databases).map(([name, result]) => [
				name,
				result.ok ? { ok: true, latencyMs: result.latencyMs } : { ok: false },
			]),
		),
		up ? 200 : 503,
	);
});
```

## What it reports

`Record<DbName, PingResult>`, where `PingResult` is `@nxgt/mongo`'s —
`import type { PingResult } from '@nxgt/mongo'`:

| Result | Means |
| --- | --- |
| `{ ok: true, latencyMs }` | the server answered `ping`, in that many milliseconds |
| `{ ok: false, error }` | it did not, within `timeoutMS`; `error` is the driver's — `MongoOperationTimeoutError` for a server too slow, `MongoNetworkError` or `MongoServerSelectionError` for one that is gone — or, for a `client` the configuration handed over, `Error('ping: no answer in 1000ms')` when the deadline passed first |

The keys are the database names the configuration gave, `default` when it
named none, and the types know them: `health.main` on a kit with no `main`
does not compile.

Keep `error` in the log and out of the response: a driver error can name the
host it tried.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `timeoutMS` | `number` | `2000` | The deadline for each database, and for the whole call, since they run at once. Spelt as the driver spells it |

## Which kit, which client

Every kit answers — the one `createKit` returned, one from `as` or
`withSession`, one inside a transaction — because they share the databases.
The ping carries no session and no actor.

A database the kit opened from a `uri` is pinged through its connection, and
reports the driver's own errors. A database the configuration gave a `client`
is pinged too, through a copy with a timer of its own. The timer is there
because of what was measured on mongodb 7.6.0: a client that was **never
connected** makes its connect on the first command, and that connect waits
`serverSelectionTimeoutMS` (30 s by default), not the command's `timeoutMS`.
The timer keeps `ping`'s deadline anyway, and is where the bare
`ping: no answer in …` error comes from.

A failed first connect has a second consequence: the driver **closes the
client for good**. Every later command throws `MongoTopologyClosedError` at
once, and so does every later `ping`, whether the server came back or not.
Connect a client before handing it to the configuration:

```ts
const client = await new MongoClient(uri).connect();
const kit = await createKit(defineConfig({ client, collections }));
```
