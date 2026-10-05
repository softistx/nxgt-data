import {
	bindIdempotency as bindIdempotencyFrom,
	bindRateLimit as bindRateLimitFrom,
	defineIdempotency as defineIdempotencyFrom,
	defineRateLimit as defineRateLimitFrom,
	GuardError as GuardErrorFrom,
} from '@nxgt/redis';

// This package moved into `@nxgt/redis`. Every name below is that package's,
// re-exported under the same name, and nothing is renamed or reworded; each is
// marked deprecated so an editor points at the new home.

/** @deprecated Use bindIdempotency from @nxgt/redis */
export const bindIdempotency = bindIdempotencyFrom;

/** @deprecated Use bindRateLimit from @nxgt/redis */
export const bindRateLimit = bindRateLimitFrom;

/** @deprecated Use defineIdempotency from @nxgt/redis */
export const defineIdempotency = defineIdempotencyFrom;

/** @deprecated Use defineRateLimit from @nxgt/redis */
export const defineRateLimit = defineRateLimitFrom;

/** @deprecated Use GuardError from @nxgt/redis */
export const GuardError = GuardErrorFrom;
/** @deprecated Use GuardError from @nxgt/redis */
export type GuardError = GuardErrorFrom;

/** @deprecated Use GuardErrorCode from @nxgt/redis */
/** @deprecated Use BoundIdempotency from @nxgt/redis */
/** @deprecated Use BoundRateLimit from @nxgt/redis */
/** @deprecated Use IdempotencyDefinition from @nxgt/redis */
/** @deprecated Use Idempotent from @nxgt/redis */
/** @deprecated Use LimitResult from @nxgt/redis */
/** @deprecated Use RateLimitDefinition from @nxgt/redis */
/** @deprecated Use RunOptions from @nxgt/redis */
export type {
	BoundIdempotency,
	BoundRateLimit,
	GuardErrorCode,
	IdempotencyDefinition,
	Idempotent,
	LimitResult,
	RateLimitDefinition,
	RunOptions,
} from '@nxgt/redis';
