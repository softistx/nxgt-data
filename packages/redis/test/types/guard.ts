// What this package refuses. Checked by `tsc --noEmit`, never run: a refusal
// that stops holding fails the typecheck on its unused directive.
import { RedisClient } from 'bun';
import {
	type BoundRateLimit,
	bindRateLimit,
	defineRateLimit,
	type GuardError,
	type GuardErrorCode,
	type LimitResult,
} from '../../src';
import { exportLimit, loginLimit } from '../fixtures';

const client = new RedisClient('redis://127.0.0.1:1');
const login = bindRateLimit(client, loginLimit);
const exports = bindRateLimit(client, exportLimit);

// The params are the key function's, and what comes back is a LimitResult.
const typed: BoundRateLimit<{ ip: string }> = login;
const result: Promise<LimitResult> = login.consume({ ip: '10.0.0.1' }, 2);
void typed;
void result;

// @ts-expect-error the key is built from `{ ip }`, not a bare string
login.consume('10.0.0.1');

// @ts-expect-error `ip` is part of the key
login.peek({});

// @ts-expect-error `user` is part of the key
exports.enforce({ org: 'acme' });

// @ts-expect-error a cost is a number, not a string
login.consume({ ip: '10.0.0.1' }, '2');

// @ts-expect-error nor for peek
login.peek({ ip: '10.0.0.1' }, '0');

// @ts-expect-error reset takes the params only
login.reset({ ip: '10.0.0.1' }, 1);

// @ts-expect-error a result is read-only
(await login.consume({ ip: '10.0.0.1' })).allowed = true;

// @ts-expect-error `per` is required: a rate needs its window
defineRateLimit({ name: 'x', key: (id: string) => id, limit: 5 });

// @ts-expect-error `limit` is required
defineRateLimit({ name: 'x', key: (id: string) => id, per: 1_000 });

// @ts-expect-error `key` is required, or every caller would share one bucket
defineRateLimit({ name: 'x', limit: 5, per: 1_000 });

defineRateLimit({
	name: 'x',
	// @ts-expect-error a key is a string
	key: (id: string) => id.length,
	limit: 5,
	per: 1_000,
});

// @ts-expect-error `per` is a number of milliseconds, not a duration string
defineRateLimit({ name: 'x', key: (id: string) => id, limit: 5, per: '1m' });

defineRateLimit({
	name: 'x',
	key: (id: string) => id,
	limit: 5,
	per: 1_000,
	// @ts-expect-error `burst` is a number
	burst: '10',
});

defineRateLimit({
	name: 'x',
	key: (id: string) => id,
	limit: 5,
	per: 1_000,
	// @ts-expect-error there is no `window`: it is called `per`
	window: 1_000,
});

// @ts-expect-error a definition is frozen
loginLimit.limit = 10;

// @ts-expect-error bindRateLimit needs a client first
bindRateLimit(loginLimit);

// The codes are a closed set.
const code: GuardErrorCode = 'RATE_LIMITED';
void code;
// @ts-expect-error not a code this package has
const unknown: GuardErrorCode = 'LIMITED';
void unknown;

// retryAfter may be absent: a COST refusal has none.
declare const error: GuardError;
// @ts-expect-error possibly undefined
const wait: number = error.retryAfter;
void wait;
