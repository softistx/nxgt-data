import { defineCache } from '@nxgt/redis';
import { z } from 'zod';

export const userSchema = z.object({
	id: z.string(),
	email: z.string(),
	seats: z.number().default(1),
});

export type User = z.output<typeof userSchema>;

/** Keyed by a plain id. */
export const users = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 60,
	schema: userSchema,
});

/** Keyed by more than one thing, which is why `key` takes an object. */
export const seats = defineCache({
	name: 'seat',
	key: (params: { org: string; user: string }) =>
		`${params.org}/${params.user}`,
	ttl: 60,
	schema: z.object({ taken: z.number() }),
});

/** Not a definition: the scope must skip it rather than trip over it. */
export const CACHE_NOTE = 'exported beside the definitions, on purpose';
