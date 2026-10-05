import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../scripts/run-script';

/*
 * One hash per key, `<name>:<key>`, and only two shapes of it, each exactly
 * three fields:
 *
 * - running: `state` = `running`, `token` (32 hex, this run's), `fp`;
 *   `PEXPIRE lease`, renewed by `RENEW` every third of it while `work` runs;
 * - done:    `state` = `done`, `fp`, `value` (JSON); `EXPIRE ttl`.
 *
 * `fp` is a SHA-256 in lowercase hex, or `''` for a run with no fingerprint.
 * Nothing here reads a clock: every expiry is the server's own, and `PTTL`
 * is what a caller is told to wait.
 */

/**
 * Takes the key, or says what holds it.
 *
 * A record is trusted only if this package could have written it: exactly
 * three fields, a known `state`, an `fp` that is `''` or 64 hex, a running
 * record with a 32-hex token and no value, a done one with a value and no
 * token, and an expiry on either. Anything else is `corrupt`, which `run`
 * refuses with `INVALID` — never read as free, which would run the work a
 * second time, and never as a mismatch, which would blame the client. No
 * loop: `HLEN` is read before anything is fetched. A key of another type
 * fails the `HLEN` with Redis's own `WRONGTYPE`.
 *
 * ARGV: token, fingerprint, lease (ms).
 * Returns `{'started'}`, `{'mismatch'}`, `{'corrupt'}`,
 * `{'running', pttl}` or `{'done', value}`.
 */
export const BEGIN = defineScript(`
local key = KEYS[1]
local fields = redis.call('HLEN', key)
if fields == 0 then
	redis.call('HSET', key, 'state', 'running', 'token', ARGV[1], 'fp', ARGV[2])
	redis.call('PEXPIRE', key, ARGV[3])
	return {'started'}
end
if fields ~= 3 then return {'corrupt'} end
local f = redis.call('HMGET', key, 'state', 'token', 'fp', 'value')
local state, token, fp, value = f[1], f[2], f[3], f[4]
local pttl = redis.call('PTTL', key)
if pttl <= 0 or not fp then return {'corrupt'} end
if fp ~= '' and not (#fp == 64 and string.match(fp, '^[0-9a-f]+$')) then
	return {'corrupt'}
end
local running = state == 'running' and not value and token
	and #token == 32 and string.match(token, '^[0-9a-f]+$')
local done = state == 'done' and not token and value
if not running and not done then return {'corrupt'} end
if fp ~= ARGV[2] then return {'mismatch'} end
if running then return {'running', pttl} end
return {'done', value}
`);

/**
 * Stores the result, if this run still holds the key: the token must match
 * and the record must still be running. Returns 1, or 0 when the lease
 * lapsed — the key expired, or another run took it since.
 *
 * ARGV: token, value (JSON), ttl (s).
 */
export const COMPLETE = defineScript(`
local f = redis.call('HMGET', KEYS[1], 'state', 'token')
if f[1] ~= 'running' or f[2] ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'done', 'value', ARGV[2])
redis.call('HDEL', KEYS[1], 'token')
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`);

/**
 * Pushes a running record's end back by `lease`, if this run still holds it:
 * a compare-and-renew on the token, so a run that lost its key cannot keep
 * another run's marker alive, nor a finished result's `ttl` be cut to a
 * lease. Returns 1, or 0 when the key is gone, done, or another run's.
 *
 * ARGV: token, lease (ms).
 */
export const RENEW = defineScript(`
local f = redis.call('HMGET', KEYS[1], 'state', 'token')
if f[1] ~= 'running' or f[2] ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`);

/**
 * Gives the key back, if this run still holds it: a compare-and-delete, so
 * a run whose lease lapsed cannot free the key another run has since taken.
 *
 * ARGV: token.
 */
export const RELEASE = defineScript(`
local f = redis.call('HMGET', KEYS[1], 'state', 'token')
if f[1] == 'running' and f[2] == ARGV[1] then
	return redis.call('DEL', KEYS[1])
end
return 0
`);

/** What `BEGIN` found. */
export type Begun =
	| { readonly state: 'started' | 'mismatch' | 'corrupt' }
	| { readonly state: 'running'; readonly pttl: number }
	| { readonly state: 'done'; readonly value: string };

/** Runs `BEGIN`, and reads its reply. */
export async function begin(
	client: RedisClient,
	key: string,
	token: string,
	fingerprint: string,
	lease: number,
): Promise<Begun> {
	const reply = await runScript(
		client,
		BEGIN,
		[key],
		[token, fingerprint, lease],
	);
	const [state, detail] = reply as [string, unknown];
	if (state === 'running' && typeof detail === 'number') {
		return { state, pttl: detail };
	}
	if (state === 'done' && typeof detail === 'string') {
		return { state, value: detail };
	}
	if (state === 'started' || state === 'mismatch') return { state };
	return { state: 'corrupt' };
}

/** Runs `COMPLETE`: `true` when the result was stored. */
export async function complete(
	client: RedisClient,
	key: string,
	token: string,
	json: string,
	ttl: number,
): Promise<boolean> {
	return (await runScript(client, COMPLETE, [key], [token, json, ttl])) === 1;
}

/** Runs `RENEW`: `true` when this run's lease was pushed back. */
export async function renew(
	client: RedisClient,
	key: string,
	token: string,
	lease: number,
): Promise<boolean> {
	return (await runScript(client, RENEW, [key], [token, lease])) === 1;
}

/** Runs `RELEASE`: `true` when this run's marker was deleted. */
export async function release(
	client: RedisClient,
	key: string,
	token: string,
): Promise<boolean> {
	return (await runScript(client, RELEASE, [key], [token])) === 1;
}

/** A token for one run: 128 random bits, as 32 lowercase hex. */
export function newToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
		'hex',
	);
}
