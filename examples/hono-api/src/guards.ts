import type { LimitResult } from '@nxgt/redis-guard';

/**
 * The HTTP side of `@nxgt/redis-guard`, shared by every module that guards a
 * route: `@nxgt/redis-guard` answers in milliseconds, and HTTP asks for
 * seconds.
 */

/**
 * A delay in milliseconds as HTTP's whole seconds, rounded **up**: rounding
 * down would tell a client to come back before it may.
 */
export const seconds = (ms: number): string => String(Math.ceil(ms / 1000));

/**
 * The draft-standard `RateLimit-*` headers, and `Retry-After` on a denial.
 * Every one is a delay, never a date, so no clock is involved: the client
 * counts from when it read the response.
 */
export function rateLimitHeaders(result: LimitResult): Headers {
	const headers = new Headers({
		'RateLimit-Limit': String(result.limit),
		'RateLimit-Remaining': String(result.remaining),
		'RateLimit-Reset': seconds(result.resetAfter),
	});
	if (!result.allowed) headers.set('Retry-After', seconds(result.retryAfter));
	return headers;
}
