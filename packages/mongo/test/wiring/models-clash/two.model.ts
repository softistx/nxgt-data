import { z } from 'zod';
import { defineCollection } from '../../../src/definition/define-collection';
import { id } from '../../../src/definition/fields';

/** The same server collection as `one.model.ts`: discovery refuses both. */
export const definition = defineCollection({
	name: 'twice',
	schema: z.object({ _id: id() }),
});
