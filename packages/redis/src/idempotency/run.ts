import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { GuardError } from '../errors/guard-error';
import { checkTimeout, timedOut, withinTimeout } from '../scripts/timeout';
import { keepLease } from './lease/heartbeat';
import { beginOrWait, checkWait } from './lease/wait';
import { corrupt, fromStored, toStored } from './result';
import { type Begun, complete, newToken, release } from './scripts';
import type { Idempotent, RunOptions } from './types';

/** What a bound operation resolved from its definition. */
export interface Context {
	readonly client: RedisClient;
	readonly name: string;
	/** Seconds a finished result is kept. */
	readonly ttl: number;
	/** Milliseconds the in-flight marker lives unless renewed. */
	readonly lease: number;
	readonly schema: z.ZodType;
}

/**
 * The fingerprint as stored: SHA-256 in lowercase hex, or `''` for none. The
 * body itself never reaches Redis, and a stored fingerprint is always the
 * same length whatever the body's.
 */
export function fingerprintOf(given: RunOptions['fingerprint']): string {
	if (given === undefined) return '';
	if (typeof given !== 'string' && !ArrayBuffer.isView(given)) {
		throw new TypeError(
			'run: a fingerprint is a string or an ArrayBufferView, such as the raw body',
		);
	}
	// The bytes a view covers, whatever its kind: Bun's hasher is typed for
	// typed arrays and not a `DataView`, and a view's own `buffer` may hold
	// more than it covers — a `Buffer` from Bun's pool does.
	const input =
		typeof given === 'string'
			? given
			: new Uint8Array(given.buffer, given.byteOffset, given.byteLength);
	return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

/** Why `run` did not start: every answer of `BEGIN` but `started`. */
async function notStarted<T>(
	ctx: Context,
	found: Begun,
): Promise<Idempotent<T>> {
	const { name } = ctx;
	switch (found.state) {
		case 'done':
			return {
				value: await fromStored<T>(name, ctx.schema, found.value),
				replayed: true,
			};
		case 'running':
			throw new GuardError(
				'IN_PROGRESS',
				name,
				`run on "${name}": the same key is still running; retryAfter is when its lease lapses unless renewed`,
				{ retryAfter: found.pttl },
			);
		case 'mismatch':
			throw new GuardError(
				'MISMATCH',
				name,
				`run on "${name}": this key was first used with a different fingerprint; ` +
					'a repeat must send the same request',
			);
		default:
			throw corrupt(name);
	}
}

/** The error of a run whose key was taken from it before it could store. */
function leaseLost(ctx: Context): GuardError {
	return new GuardError(
		'LEASE_LOST',
		ctx.name,
		`run on "${ctx.name}": the key was taken from this run before it finished ` +
			`(forgotten, or its lease of ${ctx.lease}ms went unrenewed), so a ` +
			'repeat may have run it too; its result was not stored',
	);
}

/**
 * Waits for one of `run`'s commands at most `timeoutMs`, then rejects with
 * `TIMEOUT`, saying what the command left behind.
 */
function bound(ctx: Context, timeoutMs: number | undefined) {
	return <T>(pending: Promise<T>, consequence: string): Promise<T> =>
		withinTimeout(pending, timeoutMs, (ms) =>
			timedOut('run', ctx.name, ms, consequence),
		);
}

/**
 * Takes the key, or finds what holds it. A `BEGIN` that fails — timed out
 * above all — may still take the key on the server, so a release under this
 * run's token is sent behind it, not awaited: Redis runs one connection's
 * commands in order, so it frees a key the late `BEGIN` took, and touches
 * nothing else.
 */
async function take(
	ctx: Context,
	key: string,
	token: string,
	fingerprint: string,
	wait: number,
	bounded: ReturnType<typeof bound>,
) {
	try {
		return await beginOrWait(
			ctx.client,
			key,
			token,
			fingerprint,
			ctx.lease,
			wait,
			(pending) =>
				bounded(pending, '`work` was not called; a key it took is released'),
		);
	} catch (error) {
		release(ctx.client, key, token).catch(() => undefined);
		throw error;
	}
}

/**
 * One `run`: take the key — waiting up to `wait` for a running one — or
 * replay or refuse what holds it; run `work`, renewing the lease every third
 * of it; store its result if this run still holds the key. Each command
 * waits at most `timeoutMs`, when it is given.
 *
 * Whatever `work` throws, and a result the schema refuses, gives the key
 * back before the error leaves — never stored, so the next call runs again.
 * A failure to give it back must not replace that error: the marker then
 * lapses with its lease. The renewals stop before `run` settles, whichever
 * way it does.
 */
export async function run<T, I>(
	ctx: Context,
	key: string,
	work: () => Promise<I> | I,
	options?: RunOptions,
): Promise<Idempotent<T>> {
	const fingerprint = fingerprintOf(options?.fingerprint);
	const wait = checkWait(ctx.name, options?.wait);
	const bounded = bound(ctx, checkTimeout('run', ctx.name, options?.timeoutMs));
	const token = newToken();
	const { client, lease } = ctx;
	const found = await take(ctx, key, token, fingerprint, wait, bounded);
	if (found.state !== 'started') return await notStarted<T>(ctx, found);

	const heartbeat = keepLease(client, key, token, lease);
	let stored: { json: string; value: T };
	try {
		stored = await toStored<T>(ctx.name, ctx.schema, await work());
	} catch (error) {
		heartbeat.stop();
		// A release that fails or times out never replaces `work`'s error: the
		// marker then lapses with its lease.
		await bounded(
			release(client, key, token),
			'the key lapses with its lease',
		).catch(() => undefined);
		throw error;
	} finally {
		heartbeat.stop();
	}
	// A renewal that found the key gone or another run's already knows that
	// `COMPLETE` would refuse; one still in flight at the stop is `COMPLETE`'s
	// to find.
	if (
		heartbeat.lost ||
		!(await bounded(
			complete(client, key, token, stored.json, ctx.ttl),
			'`work` ran, and its result may or may not be stored: a repeat ' +
				'replays it if it was, or runs `work` again once the lease lapses',
		))
	) {
		throw leaseLost(ctx);
	}
	return { value: stored.value, replayed: false };
}
