// What idempotency refuses. Checked by `tsc --noEmit`, never run: a refusal
// that stops holding fails the typecheck on its unused directive.
import { RedisClient } from 'bun';
import { z } from 'zod';
import {
	type BoundIdempotency,
	bindIdempotency,
	defineIdempotency,
	type GuardErrorCode,
	type Idempotent,
} from '../../src';
import { chargeCard, createOrder } from '../fixtures';

const client = new RedisClient('redis://127.0.0.1:1');
const orders = bindIdempotency(client, createOrder);
const charges = bindIdempotency(client, chargeCard);
const who = { user: 'u1', key: 'k1' };

// What comes back is the schema's output, `status` filled; what work returns
// is its input, where `status` may be left out.
const result: Promise<
	Idempotent<{ orderId: string; total: number; status: string }>
> = orders.run(who, () => ({ orderId: 'o1', total: 1 }));
void result;
const typed: BoundIdempotency<
	{ user: string; key: string },
	{ orderId: string; total: number; status: string },
	{ orderId: string; total: number; status?: string | undefined }
> = orders;
void typed;

// Work may be async, and a fingerprint may be bytes.
orders.run(who, async () => ({ orderId: 'o1', total: 1 }), {
	fingerprint: new Uint8Array([1, 2]),
});

// @ts-expect-error work returns what the schema accepts: `total` is a number
orders.run(who, () => ({ orderId: 'o1', total: '1' }));

// @ts-expect-error nor may it leave out a field without a default
orders.run(who, async () => ({ orderId: 'o1' }));

// @ts-expect-error a union's member must be one the schema has
charges.run('c1', () => ({ ok: false, chargeId: 'ch_1' }));

// @ts-expect-error a fingerprint is a string or bytes, not a number
orders.run(who, () => ({ orderId: 'o1', total: 1 }), { fingerprint: 42 });

// @ts-expect-error the params are the key function's: `key` is missing
orders.run({ user: 'u1' }, () => ({ orderId: 'o1', total: 1 }));

// @ts-expect-error nor a bare string
orders.forget('u1/k1');

// @ts-expect-error the value is read-only
(await orders.run(who, () => ({ orderId: 'o1', total: 1 }))).replayed = false;

// @ts-expect-error `ttl` is required: a result is kept for a stated time
defineIdempotency({ name: 'x', key: (id: string) => id, schema: z.string() });

// @ts-expect-error `schema` is required: a stored result is checked both ways
defineIdempotency({ name: 'x', key: (id: string) => id, ttl: 60 });

defineIdempotency({
	name: 'x',
	key: (id: string) => id,
	// @ts-expect-error `ttl` is a number of seconds, not a duration string
	ttl: '1d',
	schema: z.string(),
});

defineIdempotency({
	name: 'x',
	key: (id: string) => id,
	ttl: 60,
	schema: z.string(),
	// @ts-expect-error there is no `timeout`: the in-flight marker is `lease`
	timeout: 5_000,
});

// @ts-expect-error a definition is frozen
createOrder.ttl = 60;

// @ts-expect-error bindIdempotency needs a client first
bindIdempotency(createOrder);

// The idempotency codes are codes like the others.
const codes: GuardErrorCode[] = [
	'IN_PROGRESS',
	'MISMATCH',
	'INVALID',
	'LEASE_LOST',
];
void codes;
