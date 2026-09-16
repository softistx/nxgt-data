import { z } from 'zod';
import { defineCollection } from '../src/definition/define-collection';
import { id, objectId } from '../src/definition/fields';

/** Three collections that point to one another, for the aggregation specs. */
export const teams = defineCollection({
	name: 'teams',
	schema: z.object({ _id: id(), name: z.string() }),
	softDelete: true,
});

export const members = defineCollection({
	name: 'members',
	schema: z.object({
		_id: id(),
		name: z.string(),
		teamId: objectId().nullable().default(null),
		mentorIds: z.array(objectId()).default([]),
		level: z.string().optional(),
		score: z.number().optional(),
		tags: z.array(z.string()).default([]),
	}),
	softDelete: true,
});
