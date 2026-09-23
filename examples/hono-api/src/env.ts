import { z } from 'zod';

const envSchema = z.object({
	// Node environment
	NODE_ENV: z
		.enum(['development', 'production', 'test'])
		.default('development'),

	// Server
	PORT: z.coerce.number().default(3000),

	// Database
	MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/blog'),

	// Redis: the rate limit's buckets and the idempotency keys
	REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `Record<keyof Env, …>` rather than `Record<string, unknown>`: the map below
 * is then checked against the schema's own keys, so a variable that is
 * declared and never passed — or passed and declared nowhere — is a compile
 * error instead of a value that silently falls to its default.
 *
 * `| undefined` because any of them may be unset; that is what the defaults
 * are for.
 */
const parseEnv = (value: Record<keyof Env, string | undefined>): Env => {
	const result = envSchema.safeParse(value);

	if (!result.success) {
		console.error('❌ Invalid environment variables:');
		console.error(z.prettifyError(result.error));
		throw new Error('Invalid environment variables');
	}

	return result.data;
};

// An explicit map, not `Bun.env` as a whole: what this app reads is the list
// above and nothing else, and a variable missing from this map is invisible
// to it whatever the shell exports.
//
// It is read here, at module scope, so a bad `PORT` stops the process before
// it opens a connection rather than on the first request.
export const env = parseEnv({
	NODE_ENV: Bun.env.NODE_ENV,
	PORT: Bun.env.PORT,
	MONGO_URI: Bun.env.MONGO_URI,
	REDIS_URL: Bun.env.REDIS_URL,
});
