# Idempotency

An idempotent operation runs once per key, however many times it is asked
for. A client that sends `POST /orders` with an `Idempotency-Key`, times out,
and sends it again gets the order it placed the first time — not a second
order.

```ts
import { RedisClient } from 'bun';
import { z } from 'zod';
import { bindIdempotency, defineIdempotency } from '@nxgt/redis-guard';

export const createOrder = defineIdempotency({
	name: 'orders.create',
	key: (p: { user: string; key: string }) => `${p.user}/${p.key}`,
	ttl: 86_400,         // seconds
	lease: 30_000,       // milliseconds
	schema: z.object({ orderId: z.string(), status: z.string().default('placed') }),
});

const redis = new RedisClient(process.env.REDIS_URL);
const orders = bindIdempotency(redis, createOrder);

const first = await orders.run({ user: 'u1', key: 'k-123' }, () => placeOrder());
// { value: { orderId: 'o_1', status: 'placed' }, replayed: false }
const again = await orders.run({ user: 'u1', key: 'k-123' }, () => placeOrder());
// { value: { orderId: 'o_1', status: 'placed' }, replayed: true } — placeOrder not called
```

## Describing an operation

`defineIdempotency` describes; it talks to nothing, and gives back a frozen
copy you can export and share between modules. It throws a bare `TypeError`
for a definition that could never work, so a mistake stops the process at
import rather than at the first request.

| Field | |
| --- | --- |
| `name` | the key's prefix. Two operations must not share one — nor a rate limit or a cache |
| `key(params)` | the rest of the key. A function, so a renamed parameter is a compile error |
| `ttl` | how long a finished result is replayed, **in seconds** |
| `lease` | how long the work may take, **in milliseconds**. Default `10_000` |
| `schema` | a zod schema for the result |

A stored key is `` `<name>:<key(params)>` `` — the same shape as a rate
limit's and an `@nxgt/redis` cache's:

```ts
orders.keyFor({ user: 'u1', key: 'k-123' });   // 'orders.create:u1/k-123'
```

**Scope the key to whoever chose it.** An `Idempotency-Key` header is unique
only to the client that made it up. Key on the user, the tenant or the API
key as well, or two clients that happen to pick the same key would share one
result.

## What `run` does

`run(params, work, { fingerprint })` answers in one of five ways:

| The key holds | `run` |
| --- | --- |
| nothing | takes it, calls `work`, stores the result, resolves `{ value, replayed: false }` |
| a finished result, same fingerprint | resolves `{ value, replayed: true }`; `work` is **not** called |
| a run still going, same fingerprint | rejects with `IN_PROGRESS` and `retryAfter`, the lease left in ms |
| anything, with a different fingerprint | rejects with `MISMATCH` — whether it is finished or still running |
| a record `run` could not have written | rejects with `INVALID`, and leaves it where it is |

When `work` has run:

- **It returned a result the schema accepts** — the result is stored for
  `ttl` seconds and resolved. If the lease lapsed while `work` ran, the store
  is refused and `run` rejects with `LEASE_LOST`: see
  [The lease](#the-lease).
- **It returned a result the schema refuses** — nothing is stored, the key
  is given back, and `run` rejects with `INVALID`.
- **It threw** — nothing is stored, the key is given back, and the error
  passes through **as the same object**, so an `instanceof` in your handler
  still works. The next call with that key runs `work` again.

### The value is what the schema gives back

`work` returns what the schema **accepts** (`z.input`); `run` resolves to
what it **gives back** (`z.output`), on the first run and on every replay
alike. A field with a `.default()` may be left out by `work`, and the default
is what is stored:

```ts
const { value } = await orders.run(who, () => ({ orderId: 'o_1' }));
value.status;   // 'placed' — on the first run and on every replay
```

Before storing, `run` turns the parsed result into JSON and parses that JSON
again, and resolves **that**: the first caller gets exactly what every
replay will get. A result that could not survive the trip — a `z.date()`,
which JSON turns into a string; a `bigint`; a transform that does not accept
its own output — is refused with `INVALID` on the first run, while the key
can still be given back, rather than on every replay for a day.

### A failure worth replaying is a result

A thrown error is never stored, because most errors are worth retrying: a
timeout, a database that was down, a deploy in the middle of a request. Some
failures are an answer, though — a declined card must be declined again on
every repeat, not charged on the third. Return those as a **result**, one
member of a union:

```ts
export const chargeCard = defineIdempotency({
	name: 'payments.charge',
	key: (p: { account: string; key: string }) => `${p.account}/${p.key}`,
	ttl: 86_400,
	schema: z.discriminatedUnion('ok', [
		z.object({ ok: z.literal(true), chargeId: z.string() }),
		z.object({ ok: z.literal(false), reason: z.string() }),
	]),
});

const charges = bindIdempotency(redis, chargeCard);

const { value } = await charges.run({ account, key }, async () => {
	const charge = await provider.charge(amount);   // throws on a network error
	if (charge.declined) return { ok: false as const, reason: charge.declineCode };
	return { ok: true as const, chargeId: charge.id };
});

if (!value.ok) return Response.json({ error: value.reason }, { status: 402 });
```

## The fingerprint

A key alone cannot tell a retry from a mistake: a client that reuses a key
for a **different** request would otherwise get the first request's result
back as if it were the answer to the second. The fingerprint is what the
request said, and a repeat whose fingerprint differs is `MISMATCH`.

- Give it **the raw body** — `await request.text()` or the bytes. Not
  `JSON.stringify(parsedBody)`: that depends on key order and on what the
  parser dropped, so two identical requests could disagree and two different
  ones agree. Add whatever else makes the request what it is, such as the
  method and the path, if one key can reach several routes.
- It is hashed with SHA-256 before it goes anywhere; only the 64 hex
  characters are stored, whatever the body's size.
- A string and its UTF-8 bytes are the same fingerprint, and any
  `ArrayBufferView` is hashed over exactly the bytes it covers.
- **None is not a fingerprint.** A key first used without one and repeated
  with one — or the reverse — is `MISMATCH`, and so is `''` against none.
  Send one always, or never.

## The lease

While `work` runs, the key holds a marker that lives `lease` milliseconds,
timed by the Redis server. A process that dies mid-work therefore frees the
key when the lease lapses, rather than never.

**In this version nothing renews it.** Work that runs longer than `lease`
loses the key, and a repeat that arrives after that runs `work` a second
time. The first run then finds its token gone when it tries to store, rejects
with `LEASE_LOST`, and stores nothing: the second run's result is what
replays. So:

- set `lease` above the longest `work` can take, with room to spare;
- treat `LEASE_LOST` as "this may have happened twice" — reconcile, alert, or
  both.

A heartbeat that renews the lease while `work` runs is next on the
[roadmap](../roadmap.md).

A late run cannot damage the one that took over: storing and giving the key
back both compare this run's own random token, in the same script as the
write, so neither can overwrite or delete another run's marker.

## Choosing `ttl` and `lease`

- **`ttl` — seconds.** As long as a client might still retry: a day is
  common for payments, an hour for most forms. After it, a repeat runs again.
- **`lease` — milliseconds.** Above the slowest `work` you expect. Too short
  risks a second run; too long makes a repeat after a crash wait longer for
  `IN_PROGRESS` to clear.

The units differ on purpose: `ttl` is Redis's `EXPIRE` and `@nxgt/redis`'s
`defineCache`; `lease` is every other duration in this package, and
`retryAfter` with it. `lease: 86_400` is under a minute and a half.

## Changing the schema

A replay parses the stored result with **today's** schema. For as long as
`ttl`, results written by the previous deploy are read by this one.

- Adding a field: make it `.optional()` or give it a `.default()`.
- Removing a field: fine — unknown keys are stripped by `z.object`. Not by
  `z.strictObject`, which refuses them.
- Anything else: rename the operation (`orders.create.v2`), so old results
  stay with the old name until they expire.

A stored result the schema refuses is `INVALID`, and `work` is **not** run
again: the stored result stands for something that already happened, and
running `work` would do it twice. `forget(params)` deletes it, when you have
decided that running again is right.

## Storage

One Redis hash per key, in one of two shapes, each exactly three fields:

| State | Fields | Expiry |
| --- | --- | --- |
| running | `state` = `running`, `token` (32 hex, this run's), `fp` | `PEXPIRE lease` |
| done | `state` = `done`, `fp`, `value` (JSON) | `EXPIRE ttl` |

`fp` is the fingerprint's SHA-256 in hex, or `''` for none. Three scripts,
each over one key:

- **begin** takes the key — `HSET` and `PEXPIRE` in the same step — or reads
  what holds it;
- **complete** stores the result only if the key is still running under this
  run's token, removes the token, and sets the `ttl`;
- **release** deletes the key only if it is still this run's.

Each is one Lua script, so two processes cannot both take a key, and a late
run cannot store over or delete an earlier one's successor. Nothing reads a
host's clock: every expiry is the server's, and `retryAfter` is the key's
`PTTL`.

**A record is trusted only if `run` could have written it**: three fields, a
known state, an `fp` of `''` or 64 hex, a 32-hex token on a running record
and none on a done one, a value only on a done one, and an expiry. Anything
else — a hand edit, another program's hash under the same name — is
`INVALID` and is left alone. Not a free key, which would run `work` beside
whatever that record stood for; not `MISMATCH`, which would tell the client
it sent another request when it did not. A key of another type fails with
Redis's own `WRONGTYPE`. `forget` deletes either.

## HTTP: the `Idempotency-Key` header, for any framework

The pattern of the IETF draft *The Idempotency-Key HTTP Header Field*: the
client makes up a key per operation and sends it with every retry.

| `run` | Status | Why |
| --- | --- | --- |
| `{ replayed: false }` | the operation's own — 201 for a creation | it ran |
| `{ replayed: true }` | the **same** status as the first time | a retry must not be able to tell, except by a header if you want one |
| `IN_PROGRESS` | **409 Conflict**, with `Retry-After` | the first request has not finished |
| `MISMATCH` | **422 Unprocessable Content** | the key was used for another request |
| `INVALID` | 500 | a server-side problem: the schema and what was stored disagree |
| `LEASE_LOST` | 500, and an alert | the work may have run twice |
| no header | 400, or run without `run` | your choice per route |

```ts
import { GuardError, type BoundIdempotency } from '@nxgt/redis-guard';

export async function idempotent<T>(
	request: Request,
	bound: BoundIdempotency<{ user: string; key: string }, T, unknown>,
	user: string,
	work: (body: string) => Promise<T>,
	status = 201,
): Promise<Response> {
	const key = request.headers.get('Idempotency-Key');
	if (!key) return Response.json({ error: 'Idempotency-Key is required' }, { status: 400 });
	const body = await request.text();
	try {
		const { value, replayed } = await bound.run(
			{ user, key },
			() => work(body),
			{ fingerprint: `${request.method} ${new URL(request.url).pathname}\n${body}` },
		);
		return Response.json(value, {
			status,
			headers: replayed ? { 'Idempotent-Replayed': 'true' } : {},
		});
	} catch (error) {
		if (!(error instanceof GuardError)) throw error;
		switch (error.code) {
			case 'IN_PROGRESS':
				return Response.json({ error: 'A request with this key is still running' }, {
					status: 409,
					headers: { 'Retry-After': String(Math.ceil((error.retryAfter ?? 0) / 1000)) },
				});
			case 'MISMATCH':
				return Response.json(
					{ error: 'This Idempotency-Key was used for a different request' },
					{ status: 422 },
				);
			default:
				throw error;   // INVALID, LEASE_LOST: log and answer 500
		}
	}
}
```

`Retry-After` is in whole seconds, rounded up from `retryAfter`'s
milliseconds, so a client that waits that long finds the lease over: the
first run has finished, and a replay is waiting, or it lapsed, and the
repeat runs.

The same function works in Hono, Elysia or `Bun.serve`, since each hands you
the standard `Request` (`c.req.raw` in Hono).

## Errors

| Code | When | What happened to the key |
| --- | --- | --- |
| `IN_PROGRESS` | the key is running elsewhere | untouched |
| `MISMATCH` | another fingerprint | untouched |
| `INVALID` | `work`'s result refused | given back |
| `INVALID` | the stored result refused, or a record `run` could not have written | kept; `work` not called |
| `LEASE_LOST` | `work` outlasted its lease | whatever the run that took over made of it |

Each message names the operation — `run on "orders.create": …` — and never
the key, the fingerprint or the value, which came from a request. An
`INVALID` lists zod's issue codes, `(invalid_type, unrecognized_keys)`, and
not zod's messages or paths: measured on zod 4.6.5, `unrecognized_keys`
quotes the stray key, and a `z.record`'s keys appear in the path. Every
message is in [troubleshooting](../troubleshooting.md).
