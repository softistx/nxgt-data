import type { z } from 'zod';

/**
 * One cached thing: what it is called, how its key is built from the
 * parameters that identify it, how long it lives, and the shape it holds.
 *
 * The key is a **function**, not a template, so nothing is spelled by hand at
 * a call site and a renamed parameter is a compile error.
 */
export interface CacheDefinition<P, S extends z.ZodType> {
	/** The key's prefix. A stored key is `<name>:<key(params)>`. */
	readonly name: string;
	/** The rest of the key, from whatever identifies the value. */
	readonly key: (params: P) => string;
	/** How long a value lives, **in seconds** — Redis's own unit for `EX`. */
	readonly ttl: number;
	/** What is stored. Checked on the way in *and* on the way out. */
	readonly schema: S;
}

/** What the definition's `key` takes, so a bound cache can ask for it. */
export type ParamsOf<D> =
	D extends CacheDefinition<infer P, z.ZodType> ? P : never;

/**
 * What the definition's schema gives back.
 *
 * `never` for the parameters, not `unknown`: `key` takes them, so the
 * definition is **contravariant** in `P`, and under `strictFunctionTypes` a
 * `CacheDefinition<string, …>` is not assignable to one of `unknown` — which
 * made this resolve to `never` for every definition whose key took anything
 * narrower. `never` is the bottom of that ordering, so every definition
 * matches. Measured in `test/types/redis.ts`.
 */
export type ValueOf<D> =
	D extends CacheDefinition<never, infer S> ? z.output<S> : never;
