import { z } from 'zod';
import { defineCollection } from '../../../src/definition/define-collection';
import { id } from '../../../src/definition/fields';

/** Outside the glob: `*.model.ts` does not match this file. */
export const definition = defineCollection({
	name: 'discovered_notes',
	schema: z.object({ _id: id(), body: z.string() }),
});
