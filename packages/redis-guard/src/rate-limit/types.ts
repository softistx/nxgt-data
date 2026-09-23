/**
 * One rate limit: what it is called, how its key is built from what it
 * limits, and the rate.
 *
 * The key is a **function**, not a template, so nothing is spelled by hand at
 * a call site and a renamed parameter is a compile error.
 */
export interface RateLimitDefinition<P> {
	/** The key's prefix. A stored key is `<name>:<key(params)>`. */
	readonly name: string;
	/** The rest of the key, from whatever is limited: a user, an address. */
	readonly key: (params: P) => string;
	/** How many requests `per` allows, once the bucket has refilled. */
	readonly limit: number;
	/** The window `limit` is counted over, **in milliseconds**. */
	readonly per: number;
	/**
	 * How many requests may arrive at once, from a full bucket. Defaults to
	 * `limit`. Above it, the limit tolerates a burst and then holds to the
	 * rate; below it, requests are spread out more evenly.
	 */
	readonly burst?: number;
}

/**
 * What a check found. Every duration is a **delay in milliseconds**, measured
 * on the Redis server's clock, never a date: the caller's clock and the
 * server's need not agree, and a delay means the same on both.
 */
export interface LimitResult {
	/** Whether this call was allowed — and, for `consume`, counted. */
	readonly allowed: boolean;
	/** The burst: how many requests a full bucket holds. */
	readonly limit: number;
	/** How many requests of cost 1 would be allowed now, after this one. */
	readonly remaining: number;
	/** Milliseconds until the bucket is full again; `0` when it is. */
	readonly resetAfter: number;
	/** Milliseconds until this call would be allowed; `0` when it was. */
	readonly retryAfter: number;
}

/**
 * A rate limit bound to a client. `cost` is how many requests a call counts
 * for — a whole number from 1 to the burst, and from 0 for `peek`.
 */
export interface BoundRateLimit<P> {
	/** The key this would use, for a caller that needs the string itself. */
	keyFor(params: P): string;
	/** Counts the call if it is allowed. A denial counts nothing. */
	consume(params: P, cost?: number): Promise<LimitResult>;
	/**
	 * `consume`, throwing `GuardError` with `RATE_LIMITED` and its
	 * `retryAfter` when the call is denied.
	 */
	enforce(params: P, cost?: number): Promise<LimitResult>;
	/** What `consume` would answer, without counting anything. */
	peek(params: P, cost?: number): Promise<LimitResult>;
	/** Refills the bucket. `true` when something was counted. */
	reset(params: P): Promise<boolean>;
}
