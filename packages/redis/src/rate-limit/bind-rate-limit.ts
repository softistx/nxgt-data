import type { RedisClient } from 'bun';
import { GuardError } from '../errors/guard-error';
import { checkTimeout, timedOut, withinTimeout } from '../scripts/timeout';
import { checkRateLimit } from './define-rate-limit';
import { checkRate, type Rate } from './gcra';
import type {
	BoundRateLimit,
	LimitCallOptions,
	LimitResult,
	RateLimitDefinition,
} from './types';

/**
 * Refuses a cost that is not a whole number from `min` to the burst. A cost
 * can come from a request — the size of a batch, the rows an export asks
 * for — so this is a `GuardError` with a code, and the message quotes the
 * bounds, which are the code's, and never the cost, which may not be.
 */
function checkCost(
	call: string,
	name: string,
	cost: number,
	min: 0 | 1,
	burst: number,
): void {
	if (Number.isSafeInteger(cost) && cost >= min && cost <= burst) return;
	throw new GuardError(
		'COST',
		name,
		`${call} on "${name}": a cost must be a whole number from ${min} to the burst of ${burst}`,
	);
}

/**
 * Binds a rate limit to a client.
 *
 * ```ts
 * const login = bindRateLimit(redis, loginLimit);
 * const result = await login.consume({ ip });
 * if (!result.allowed) return tooManyRequests(result.retryAfter);
 * ```
 *
 * Each check is one script on the server, timed by the server's clock, so
 * every process sharing the Redis shares the limit exactly — see `gcra.ts`.
 */
export function bindRateLimit<P>(
	client: RedisClient,
	definition: RateLimitDefinition<P>,
): BoundRateLimit<P> {
	checkRateLimit(definition, 'bindRateLimit');
	const { name, limit, per } = definition;
	const rate: Rate = { limit, per, burst: definition.burst ?? limit };
	const keyFor = (params: P) => `${name}:${definition.key(params)}`;

	/**
	 * One check: the cost and the timeout refused before anything is sent,
	 * then the script, waited for at most `timeoutMs`.
	 */
	const check = async (
		call: string,
		params: P,
		cost: number,
		write: boolean,
		options: LimitCallOptions | undefined,
	): Promise<LimitResult> => {
		checkCost(call, name, cost, write ? 1 : 0, rate.burst);
		const timeoutMs = checkTimeout(call, name, options?.timeoutMs);
		return await withinTimeout(
			checkRate(client, keyFor(params), rate, cost, write),
			timeoutMs,
			(ms) =>
				timedOut(
					call,
					name,
					ms,
					write
						? 'the script may still run, and count this cost'
						: 'nothing was counted',
				),
		);
	};

	return {
		definition,
		keyFor,
		consume: (params, cost = 1, options) =>
			check('consume', params, cost, true, options),
		async enforce(params, cost = 1, options) {
			const result = await check('enforce', params, cost, true, options);
			if (result.allowed) return result;
			throw new GuardError(
				'RATE_LIMITED',
				name,
				`enforce on "${name}": the limit of ${limit} per ${per}ms is spent; ` +
					'retryAfter says when to try again',
				{ retryAfter: result.retryAfter },
			);
		},
		peek: (params, cost = 1, options) =>
			check('peek', params, cost, false, options),
		reset: async (params) => (await client.del(keyFor(params))) > 0,
	};
}
