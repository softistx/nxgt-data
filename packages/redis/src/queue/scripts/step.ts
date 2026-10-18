import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';
import { NOW_LUA } from './claim';
import { parseStepBegin, parseStepCommit, type StepBegin } from './replies';

/*
 * The fence of a durable step: a handler's step may be read or written only
 * by the attempt that holds the job, and only while its lease has not
 * lapsed. Both are checked in the script, on the server's clock, because
 * after a lapse another worker may already hold the job under a new token,
 * or be about to: a step value written by a stale attempt must never
 * overwrite the live attempt's.
 *
 * The step's field is `step:<name>` in the job hash; the caller passes the
 * whole field name. A step that returned `undefined` is stored as the empty
 * string, which is a value like any other.
 */

/**
 * The fence, shared by `STEP_BEGIN` and `STEP_COMMIT` so one body exists:
 * `held(key, id, token, now)` is true when the job hash holds `token` and
 * `id` is in `active` with a score (the lease deadline) above `now`. A job
 * not in `active` (removed, completed, failed, reclaimed) is lost. Needs
 * `NOW_LUA` ahead of it and `KEYS[2]` to be `active`.
 */
const HELD_LUA = `
-- '> now' agrees on purpose with CLAIM's '(now' reclaim boundary: a deadline
-- equal to now counts as lapsed, so no instant lets a job be both reclaimable
-- and allowed to step.
local function held(key, id, token, now)
	if redis.call('HGET', key, 'token') ~= token then return false end
	local deadline = redis.call('ZSCORE', KEYS[2], id)
	return deadline ~= false and tonumber(deadline) > now
end
`;

/**
 * Starts a step: answers its stored value, or allows the run.
 *
 * Under the fence, a stored step answers its JSON and leaves the lease
 * alone; a fresh step pushes the lease to `now + lease`, so the run starts
 * with a full one, and is allowed.
 *
 * KEYS: the job's hash, active.
 * ARGV: token, field (`step:<name>`), lease (ms), id.
 * Returns `{1, json}` (stored), `{0}` (run it) or `{-1}` (lost).
 */
export const STEP_BEGIN = defineScript(`
${NOW_LUA}
${HELD_LUA}
local id = ARGV[4]
if not held(KEYS[1], id, ARGV[1], now) then return {-1} end
local stored = redis.call('HGET', KEYS[1], ARGV[2])
if stored then return {1, stored} end
redis.call('ZADD', KEYS[2], 'XX', 'GT', string.format('%d', now + tonumber(ARGV[3])), id)
return {0}
`);

/**
 * Stores a step's value under the fence, replacing nothing a stale attempt
 * could reach: a refused call writes nothing.
 *
 * KEYS: the job's hash, active.
 * ARGV: token, field (`step:<name>`), json, id.
 * Returns 1 (written) or 0 (lost, nothing changed).
 */
export const STEP_COMMIT = defineScript(`
${NOW_LUA}
${HELD_LUA}
if not held(KEYS[1], ARGV[4], ARGV[1], now) then return 0 end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
return 1
`);

/** The field of the job hash that holds step `name`'s JSON. */
export function stepField(name: string): string {
	return `step:${name}`;
}

/**
 * Begins step `name` of a running job.
 *
 * @param lease - ms the lease is pushed to, from the server's clock, when the step runs.
 */
export async function stepBegin(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	id: string,
	token: string,
	name: string,
	lease: number,
): Promise<StepBegin> {
	return parseStepBegin(
		await runScript(
			client,
			STEP_BEGIN,
			[keys.job(id), keys.active],
			[token, stepField(name), lease, id],
		),
	);
}

/** Stores the encoded value of step `name`; whether the fence held. */
export async function stepCommit(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	id: string,
	token: string,
	name: string,
	json: string,
): Promise<boolean> {
	return parseStepCommit(
		await runScript(
			client,
			STEP_COMMIT,
			[keys.job(id), keys.active],
			[token, stepField(name), json, id],
		),
	);
}
