import { defineQueue } from '@nxgt/redis';
import { z } from 'zod';

/** A welcome mail for one signup, or the nightly digest of the whole product. */
export const mailSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('welcome'),
		tenantId: z.string(),
		to: z.string(),
	}),
	z.object({ kind: z.literal('digest') }),
]);

/**
 * The tenants' mails. Groups give each tenant fair turns, and at most two of
 * its mails run at once, across every worker. The digest is a schedule of the
 * definition, read as 03:00 in Paris: the first worker stores it.
 */
export const mails = defineQueue({
	name: 'mails',
	schema: mailSchema,
	result: z.object({ subject: z.string() }),
	backoff: { base: '100ms', max: '10m' },
	groups: { concurrency: 2 },
	schedules: {
		digest: {
			cron: '0 3 * * *',
			timezone: 'Europe/Paris',
			data: { kind: 'digest' },
		},
	},
});
