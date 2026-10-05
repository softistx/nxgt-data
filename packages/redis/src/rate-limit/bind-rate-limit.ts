import type { RedisClient } from 'bun';
import { GuardError } from '../errors/guard-error';
import { checkRateLimit } from './define-rate-limit';
import { checkRate, type Rate } from './gcra';
import type { BoundRateLimit, RateLimitDefinition } from './types';

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

	const consume = async (call: string, params: P, cost = 1) => {
		checkCost(call, name, cost, 1, rate.burst);
		return await checkRate(client, keyFor(params), rate, cost, true);
	};

	return {
		keyFor,
		consume: (params, cost) => consume('consume', params, cost),
		async enforce(params, cost) {
			const result = await consume('enforce', params, cost);
			if (result.allowed) return result;
			throw new GuardError(
				'RATE_LIMITED',
				name,
				`enforce on "${name}": the limit of ${limit} per ${per}ms is spent; ` +
					'retryAfter says when to try again',
				{ retryAfter: result.retryAfter },
			);
		},
		async peek(params, cost = 1) {
			checkCost('peek', name, cost, 0, rate.burst);
			return await checkRate(client, keyFor(params), rate, cost, false);
		},
		reset: async (params) => (await client.del(keyFor(params))) > 0,
	};
}
