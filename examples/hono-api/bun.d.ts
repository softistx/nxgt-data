/**
 * What this application reads from the environment, so `Bun.env.MONGO_URI`
 * is a name and not a guess. The declarations say what a variable *means*,
 * never that it is set: `src/env.ts` is what parses and defaults them, and
 * it is the only file that reads `Bun.env` at all.
 */
declare module 'bun' {
	interface Env {
		// `NODE_ENV` is Bun's own declaration, and stays optional.

		/** Server */
		PORT: string;

		/** Database */
		MONGO_URI: string;

		/** Redis, for the rate limit and the idempotency keys */
		REDIS_URL: string;
	}
}
