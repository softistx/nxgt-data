import type { z } from 'zod';

/**
 * One idempotent operation: what it is called, how its key is built from
 * what identifies a request, how long a finished result is kept, and the
 * shape of that result.
 *
 * The key is a **function**, not a template, so nothing is spelled by hand at
 * a call site and a renamed parameter is a compile error.
 */
export interface IdempotencyDefinition<P, S extends z.ZodType> {
	/** The key's prefix. A stored key is `<name>:<key(params)>`. */
	readonly name: string;
	/** The rest of the key: usually the client's `Idempotency-Key`, scoped. */
	readonly key: (params: P) => string;
	/**
	 * How long a finished result is kept, **in seconds** — Redis's own unit
	 * for `EXPIRE`, and `defineCache`'s. A repeat after that runs again.
	 */
	readonly ttl: number;
	/**
	 * How long the in-flight marker lives, **in milliseconds** (default
	 * 10 000). Nothing renews it yet: work that runs longer than this can be
	 * run a second time by a repeat that arrives after it lapsed.
	 */
	readonly lease?: number;
	/**
	 * What a result is. Checked on the way in — what `work` returned — and on
	 * the way out, on every replay. It must accept its own output, and that
	 * output must survive `JSON.stringify`.
	 */
	readonly schema: S;
}

/** Options for one `run`. */
export interface RunOptions {
	/**
	 * What the request said — its raw body, usually. Hashed with SHA-256
	 * before it is stored, so the body itself never reaches Redis. A repeat
	 * with the same key and another fingerprint is refused with `MISMATCH`;
	 * so is one with a fingerprint where the first had none, and the reverse.
	 */
	fingerprint?: string | ArrayBufferView;
}

/** What `run` gives back. */
export interface Idempotent<T> {
	/** The result, as the schema gives it back — on the first run and on replays alike. */
	readonly value: T;
	/** `true` when it was stored by an earlier run, and `work` was not called. */
	readonly replayed: boolean;
}

/**
 * An idempotent operation bound to a client. `T` is what the schema gives
 * back; `I` is what it accepts, which is what `work` returns — so a field
 * with a `.default()` may be left out there, and the default is what is
 * stored and replayed.
 */
export interface BoundIdempotency<P, T, I = T> {
	/** The key this would use, for a caller that needs the string itself. */
	keyFor(params: P): string;
	/**
	 * Runs `work` once per key. The first call runs it and stores its result
	 * for the `ttl`; a repeat gets that result back without calling `work`.
	 * A repeat that arrives while the first is still running is refused with
	 * `IN_PROGRESS`. An error thrown by `work` is never stored: the key is
	 * released and the error passes through, so the next call runs again.
	 */
	run(
		params: P,
		work: () => Promise<I> | I,
		options?: RunOptions,
	): Promise<Idempotent<T>>;
	/** Forgets the key, finished or running. `true` when something was there. */
	forget(params: P): Promise<boolean>;
}
