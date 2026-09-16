import { z } from 'zod';
import { defineCollection } from '../src/definition/define-collection';
import { id, objectId } from '../src/definition/fields';

/** Collections that point to one another, for the aggregation specs. */
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
		// No default: a member may have no such field at all.
		reviewerIds: z.array(objectId()).optional(),
		level: z.string().optional(),
		score: z.number().optional(),
		tags: z.array(z.string()).default([]),
	}),
	softDelete: true,
});

/** Keyed by something other than an ObjectId, as `populate` must match too. */
export const events = defineCollection({
	name: 'events',
	schema: z.object({ _id: z.date(), label: z.string() }),
	validation: { level: 'off' },
});

export const slots = defineCollection({
	name: 'slots',
	schema: z.object({
		_id: z.object({ room: z.string(), hour: z.number() }),
		label: z.string(),
	}),
	validation: { level: 'off' },
});

export const bookings = defineCollection({
	name: 'bookings',
	schema: z.object({
		_id: id(),
		eventAt: z.date().optional(),
		slotIds: z.array(z.object({ room: z.string(), hour: z.number() })),
	}),
	validation: { level: 'off' },
});
