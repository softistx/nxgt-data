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
	lease: 30_000,       // milliseconds a crashed run holds the key
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

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `name` | `string` | required | the key's prefix. Two operations must not share one — nor a rate limit or a cache. Not empty |
| `key` | `(params: P) => string` | required | the rest of the key. A function, so a renamed parameter is a compile error |
| `ttl` | `number` | required | how long a finished result is replayed, **in seconds**. A whole number, at least 1 |
| `lease` | `number` | `10_000` | how long a run holds the key unless renewed, **in milliseconds**. A whole number, at least 1. Renewed while `work` runs — see [The lease](#the-lease) |
| `schema` | `z.ZodType` | required | the result: checked on the way in and on every replay |

```ts
interface IdempotencyDefinition<P, S extends z.ZodType> {
	readonly name: string;
	readonly key: (params: P) => string;
	readonly ttl: number;
	readonly lease?: number;
	readonly schema: S;
}

function defineIdempotency<P, S extends z.ZodType>(
	definition: IdempotencyDefinition<P, S>,
): IdempotencyDefinition<P, S>;
```

A stored key is `` `<name>:<key(params)>` `` — the same shape as a rate
limit's and an `@nxgt/redis` cache's:

```ts
orders.keyFor({ user: 'u1', key: 'k-123' });   // 'orders.create:u1/k-123'
```

**Scope the key to whoever chose it.** An `Idempotency-Key` header is unique
only to the client that made it up. Key on the user, the tenant or the API
key as well, or two clients that happen to pick the same key would share one
result.

## Binding it

`bindIdempotency(client, definition)` takes any Bun `RedisClient` — one you
made, or the `client` of an `@nxgt/redis` connection — and checks the
definition again, so one written by hand is refused the same way, with
`bindIdempotency` in the message.

```ts
function bindIdempotency<P, S extends z.ZodType>(
	client: RedisClient,
	definition: IdempotencyDefinition<P, S>,
): BoundIdempotency<P, z.output<S>, z.input<S>>;

interface BoundIdempotency<P, T, I = T> {
	keyFor(params: P): string;
	run(params: P, work: () => Promise<I> | I, options?: RunOptions): Promise<Idempotent<T>>;
	forget(params: P): Promise<boolean>;
}

interface Idempotent<T> {
	readonly value: T;          // as the schema gives it back
	readonly replayed: boolean; // true when an earlier run stored it
}
```

`forget(params)` deletes the key whether it is done or still running, and
resolves `true` when something was there — the deliberate way to let a key
run again.

`run`'s third argument:

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `fingerprint` | `string \| ArrayBufferView` | none | what the request said — the raw body, usually. Only its SHA-256 is stored; a repeat with another is `MISMATCH`. See [The fingerprint](#the-fingerprint) |
| `wait` | `number` | `0` | how long to wait for a run of the same key that is still going, **in milliseconds**, before `IN_PROGRESS`. A whole number, 0 or more. See [Waiting for a running key](#waiting-for-a-running-key) |

Either one that is not of its type rejects with a bare `TypeError` before
anything is sent.

## What `run` does

`run(params, work, { fingerprint, wait })` answers in one of five ways:

| The key holds | `run` |
| --- | --- |
| nothing | takes it, calls `work`, stores the result, resolves `{ value, replayed: false }` |
| a finished result, same fingerprint | resolves `{ value, replayed: true }`; `work` is **not** called |
| a run still going, same fingerprint | waits up to `wait` ms for it — see [Waiting for a running key](#waiting-for-a-running-key) — then, if it is still running, rejects with `IN_PROGRESS` and `retryAfter` |
| anything, with a different fingerprint | rejects with `MISMATCH` — whether it is finished or still running |
| a record `run` could not have written | rejects with `INVALID`, and leaves it where it is |

When `work` has run:

- **It returned a result the schema accepts** — the result is stored for
  `ttl` seconds and resolved. If the key was taken from this run while
  `work` ran, the store is refused and `run` rejects with `LEASE_LOST`: see
  [The lease](#the-lease).
- **It returned a result the schema refuses** — nothing is stored, the key
  is given back, and `run` rejects with `INVALID`.
- **It threw** — nothing is stored, the key is given back, and the error
  passes through **as the same object**, so an `instanceof` in your handler
  still works. The next call with that key runs `work` again.
- **Redis failed while storing the result** — the error is Redis's, as Bun's
  client gave it, and the work **has** happened. The key stays running until
  its lease lapses, since nothing renews it any more: a repeat before then
  gets `IN_PROGRESS`, and one after it runs `work` again. See
  [troubleshooting](../troubleshooting.md#the-same-request-ran-twice).

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
timed by the Redis server, and **`run` renews it every third of `lease`** —
a compare-and-renew on this run's own random token, so it only ever extends
its own marker. Work of any length therefore runs once, and a repeat during
it gets `IN_PROGRESS` (or waits, with `wait`). The renewals stop before
`run` settles, however it settles, and leave no timer behind.

`lease` is then how long a **crashed** run holds the key: a process that
dies mid-work stops renewing, and the key is free again at most `lease`
milliseconds later rather than never. A shorter lease frees it sooner and
renews more often — one small script per third of it, per running call.

The lease can still be lost, and `run` then rejects with `LEASE_LOST` and
stores nothing, when:

- **no renewal reaches Redis for a whole lease** — a connection down that
  long (a renewal that fails is tried again at the next beat), or an event
  loop **blocked by synchronous work** that long, since a timer cannot fire
  meanwhile. The key lapses, and a repeat after that runs `work` a second
  time;
- **the key was removed or taken** — `forget` during the run, or anything
  else that deletes it. The next renewal finds it gone or holding another
  run's token, and the run is marked lost; `work` is not interrupted, but
  its result will not be stored.

So:

- keep `lease` above the longest the event loop may be blocked or Redis
  unreachable, and offload long synchronous work to a `Worker`;
- treat `LEASE_LOST` as "this may have happened twice" — reconcile, alert, or
  both.

A late run cannot damage the one that took over: renewing, storing and
giving the key back all compare this run's own token, in the same script as
the write, so none can extend, overwrite or delete another run's marker.

## Waiting for a running key

Without `wait`, a repeat that arrives during the first run is refused at
once with `IN_PROGRESS`. With it, `run` waits — for the replay, usually:

```ts
const { value, replayed } = await orders.run(who, () => placeOrder(body), {
	fingerprint: body,
	wait: 5_000,   // milliseconds
});
```

It polls the key with the same script that takes it, until one of:

| The key becomes | `run` |
| --- | --- |
| done | resolves the stored result, `replayed: true`; `work` is not called |
| free — the first run threw and gave it back, or crashed and its lease lapsed | takes it and runs `work` itself, `replayed: false` |
| still running when `wait` is spent | rejects with `IN_PROGRESS`, as without `wait` |
| another fingerprint, or a record `run` could not have written | rejects with `MISMATCH` or `INVALID` at once |

The first poll comes 25 ms after the first refusal, and the pause doubles up
to 250 ms, never past the key's `retryAfter` nor the end of `wait`: a run
that finishes is noticed within a quarter of a second. The host's clock only
paces the sleeps and says when `wait` is spent; whether the key is free, done
or running is the server's answer every time.

`wait` is a whole number of milliseconds, `0` (the default) or more; any
other value — a negative number, a fraction, `NaN`, a string — rejects with
a `TypeError` before anything is sent. Keep it below whatever timeout the
request itself has.

## Choosing `ttl` and `lease`

- **`ttl` — seconds.** As long as a client might still retry: a day is
  common for payments, an hour for most forms. After it, a repeat runs again.
- **`lease` — milliseconds.** How long a crash may hold the key: renewals
  keep it alive while `work` runs, whatever `work` takes. Too short renews
  more often and loses the key to a shorter blocked event loop or outage;
  too long makes a repeat after a crash wait longer for `IN_PROGRESS` to
  clear. The default, 10 s, suits most.

The units differ on purpose: `ttl` is Redis's `EXPIRE` and `@nxgt/redis`'s
`defineCache`; `lease` is every other duration in this package, and
`retryAfter` with it. `lease: 86_400` is under a minute and a half.

Coming from 0.2.0, where the lease was not renewed and had to cover the
whole work: [Upgrading](../upgrading.md#020--030) says how to shorten it,
including during a rolling deploy.

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
| running | `state` = `running`, `token` (32 hex, this run's), `fp` | `PEXPIRE lease`, renewed every third of it |
| done | `state` = `done`, `fp`, `value` (JSON) | `EXPIRE ttl` |

`fp` is the fingerprint's SHA-256 in hex, or `''` for none. Four scripts,
each over one key:

- **begin** takes the key — `HSET` and `PEXPIRE` in the same step — or reads
  what holds it;
- **renew** pushes a running key's `PEXPIRE lease` back, only if it is still
  running under this run's token;
- **complete** stores the result only if the key is still running under this
  run's token, removes the token, and sets the `ttl`;
- **release** deletes the key only if it is still this run's.

Each is one Lua script, so two processes cannot both take a key, and a late
run cannot renew, store over or delete an earlier one's successor. Nothing reads a
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
| `IN_PROGRESS` | **409 Conflict**, with `Retry-After` | the first request has not finished, within `wait` if you gave one |
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
			{
				fingerprint: `${request.method} ${new URL(request.url).pathname}\n${body}`,
				wait: 2_000,   // a repeat during the first run gets its replay, mostly
			},
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
milliseconds: when the first run's lease lapses **unless it is renewed**.
A crashed run's key is free by then; a live one renews it, so a client that
retries then may be told 409 again, with a new `Retry-After`. Giving `run` a
`wait` answers most repeats with the replay instead, and leaves 409 for work
that outlasts it.

The same function works in Hono, Elysia or `Bun.serve`, since each hands you
the standard `Request` (`c.req.raw` in Hono).

## Errors

| Code | When | What happened to the key |
| --- | --- | --- |
| `IN_PROGRESS` | the key is running elsewhere, and `wait` (if any) ran out | untouched |
| `MISMATCH` | another fingerprint | untouched |
| `INVALID` | `work`'s result refused | given back |
| `INVALID` | the stored result refused, or a record `run` could not have written | kept; `work` not called |
| `LEASE_LOST` | the key was taken from the run: `forget`, or no renewal reached Redis for a whole lease | whatever the run that took over made of it |

Each message names the operation — `run on "orders.create": …` — and never
the key, the fingerprint or the value, which came from a request. An
`INVALID` lists zod's issue codes, `(invalid_type, unrecognized_keys)`, and
not zod's messages or paths: measured on zod 4.6.5, `unrecognized_keys`
quotes the stray key, and a `z.record`'s keys appear in the path. Every
message is in [troubleshooting](../troubleshooting.md).
