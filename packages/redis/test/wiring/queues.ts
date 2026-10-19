import { z } from 'zod';
import { defineQueue } from '../../src/queue/definition/define-queue';

/** With a `result`: `finished` resolves to it. */
export const mails = defineQueue({
	name: 'mails',
	schema: z.object({ to: z.string() }),
	result: z.object({ messageId: z.string() }),
});

/** Without a `result`: what a handler returns is ignored. */
export const digest = defineQueue({
	name: 'digest',
	schema: z.object({ day: z.string() }),
});

/** A type, exported beside them: the scope keeps only the definitions. */
export type Delivery = { to: string };
