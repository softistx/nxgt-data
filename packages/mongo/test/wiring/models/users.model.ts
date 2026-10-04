import { z } from 'zod';
import { defineCollection } from '../../../src/definition/define-collection';
import { id } from '../../../src/definition/fields';

/** What the convention exports: one definition, under `definition`. */
export const definition = defineCollection({
	name: 'discovered_users',
	schema: z.object({ _id: id(), email: z.string() }),
});

/** Not a definition: discovery leaves it where it is. */
export const helper = () => 1;
