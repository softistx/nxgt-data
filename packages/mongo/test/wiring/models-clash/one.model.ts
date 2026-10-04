import { z } from 'zod';
import { defineCollection } from '../../../src/definition/define-collection';
import { id } from '../../../src/definition/fields';

export const definition = defineCollection({
	name: 'twice',
	schema: z.object({ _id: id() }),
});
