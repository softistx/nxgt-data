import { defineCollection, id } from '@nxgt/mongo';
import { z } from 'zod';

/** The same server collection as `one.model.ts`: discovery refuses both. */
export const definition = defineCollection({
	name: 'twice',
	schema: z.object({ _id: id() }),
});
