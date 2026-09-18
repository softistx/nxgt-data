import { defineCollection, id } from '@nxgt/mongo';
import { z } from 'zod';

export const definition = defineCollection({
	name: 'discovered_posts',
	schema: z.object({ _id: id(), title: z.string() }),
});

/** A second definition in one file: `import * as` would give both. */
export const drafts = defineCollection({
	name: 'discovered_drafts',
	schema: z.object({ _id: id(), title: z.string() }),
});
