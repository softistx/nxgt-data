import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { GuardError } from '../errors/guard-error';
import { corrupt, fromStored, toStored } from './result';
import { begin, complete, newToken, release } from './scripts';
import type { Idempotent, RunOptions } from './types';

/** What a bound operation resolved from its definition. */
export interface Context {
	readonly client: RedisClient;
	readonly name: string;
	/** Seconds a finished result is kept. */
	readonly ttl: number;
	/** Milliseconds the in-flight marker lives. */
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
	found: Awaited<ReturnType<typeof begin>>,
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
				`run on "${name}": the same key is still running; retryAfter says when its lease ends`,
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

/**
 * One `run`: take the key, or replay or refuse what holds it; run `work`;
 * store its result if this run still holds the key.
 *
 * Whatever `work` throws, and a result the schema refuses, gives the key
 * back before the error leaves — never stored, so the next call runs again.
 * A failure to give it back must not replace that error: the marker then
 * lapses with its lease.
 */
export async function run<T, I>(
	ctx: Context,
	key: string,
	work: () => Promise<I> | I,
	options?: RunOptions,
): Promise<Idempotent<T>> {
	const fingerprint = fingerprintOf(options?.fingerprint);
	const token = newToken();
	const found = await begin(ctx.client, key, token, fingerprint, ctx.lease);
	if (found.state !== 'started') return await notStarted<T>(ctx, found);

	let stored: { json: string; value: T };
	try {
		stored = await toStored<T>(ctx.name, ctx.schema, await work());
	} catch (error) {
		await release(ctx.client, key, token).catch(() => undefined);
		throw error;
	}
	if (!(await complete(ctx.client, key, token, stored.json, ctx.ttl))) {
		throw new GuardError(
			'LEASE_LOST',
			ctx.name,
			`run on "${ctx.name}": the work outlasted its lease of ${ctx.lease}ms, ` +
				'so a repeat may have run it too; its result was not stored',
		);
	}
	return { value: stored.value, replayed: false };
}
