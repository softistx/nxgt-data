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

/** The same, dropping a message nobody here reads when Redis is down. */
export const fireAndForget = defineChannel({
	name: 'user.fire-and-forget',
	schema: z.object({ id: z.string(), n: z.number() }),
	key: (change) => change.id,
	fallback: 'local',
	onNoLocalReader: 'drop',
});
