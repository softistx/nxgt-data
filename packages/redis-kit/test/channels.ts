import { defineChannel } from '@nxgt/redis';
import { z } from 'zod';
import { userSchema } from './caches';

export const created = defineChannel({
	name: 'user.created',
	schema: userSchema,
});

export const deleted = defineChannel({
	name: 'user.deleted',
	schema: z.object({ id: z.string() }),
});

/** A type, exported beside them: the scope keeps only the definitions. */
export type Announcement = { channel: string };
