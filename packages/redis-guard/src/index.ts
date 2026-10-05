import {
	type BoundIdempotency as BoundIdempotencyFrom,
	type BoundRateLimit as BoundRateLimitFrom,
	type GuardErrorCode as GuardErrorCodeFrom,
	type IdempotencyDefinition as IdempotencyDefinitionFrom,
	type Idempotent as IdempotentFrom,
	type LimitResult as LimitResultFrom,
	type RateLimitDefinition as RateLimitDefinitionFrom,
	type RunOptions as RunOptionsFrom,
	defineCache as defineCacheFrom,
	bindIdempotency as bindIdempotencyFrom,
	bindRateLimit as bindRateLimitFrom,
	defineIdempotency as defineIdempotencyFrom,
	defineRateLimit as defineRateLimitFrom,
	GuardError as GuardErrorFrom,
} from '@nxgt/redis';

// The schema `IdempotencyDefinition` constrains its `S` to, read off
// `@nxgt/redis`'s own declarations so this package needs no `zod` peer.
type SchemaOf = Parameters<typeof defineCacheFrom>[0]['schema'];

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
export type GuardErrorCode = GuardErrorCodeFrom;

/** @deprecated Use BoundIdempotency from @nxgt/redis */
export type BoundIdempotency<P, T, I = T> = BoundIdempotencyFrom<P, T, I>;

/** @deprecated Use BoundRateLimit from @nxgt/redis */
export type BoundRateLimit<P> = BoundRateLimitFrom<P>;

/** @deprecated Use IdempotencyDefinition from @nxgt/redis */
export type IdempotencyDefinition<
	P,
	S extends SchemaOf = SchemaOf,
> = IdempotencyDefinitionFrom<P, S>;

/** @deprecated Use Idempotent from @nxgt/redis */
export type Idempotent<T> = IdempotentFrom<T>;

/** @deprecated Use LimitResult from @nxgt/redis */
export type LimitResult = LimitResultFrom;

/** @deprecated Use RateLimitDefinition from @nxgt/redis */
export type RateLimitDefinition<P> = RateLimitDefinitionFrom<P>;

/** @deprecated Use RunOptions from @nxgt/redis */
export type RunOptions = RunOptionsFrom;
