import { z } from 'zod';
import { defineChannel } from '../../src/channel/define-channel';

/** Keyed by user: `stream(id)` hears the messages of that id. */
export const changed = defineChannel({
	name: 'user.changed',
	schema: z.object({ id: z.string(), n: z.number() }),
	key: (change) => change.id,
});

/** The same, with the local fallback on. */
export const resilient = defineChannel({
	name: 'user.resilient',
	schema: z.object({ id: z.string(), n: z.number() }),
	key: (change) => change.id,
	fallback: 'local',
});
