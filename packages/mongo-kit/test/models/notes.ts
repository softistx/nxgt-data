import { defineCollection, id } from '@nxgt/mongo';
import { z } from 'zod';

/** Outside the glob: `*.model.ts` does not match this file. */
export const definition = defineCollection({
	name: 'discovered_notes',
	schema: z.object({ _id: id(), body: z.string() }),
});
