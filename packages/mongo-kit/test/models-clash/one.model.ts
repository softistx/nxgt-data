import { defineCollection, id } from '@nxgt/mongo';
import { z } from 'zod';

export const definition = defineCollection({
	name: 'twice',
	schema: z.object({ _id: id() }),
});
