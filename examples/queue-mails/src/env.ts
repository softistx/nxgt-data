import { z } from 'zod';

const envSchema = z.object({
	REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
});

/** The environment, parsed once: a bad value stops the process before it opens a connection. */
export const env = envSchema.parse({ REDIS_URL: Bun.env['REDIS_URL'] });
