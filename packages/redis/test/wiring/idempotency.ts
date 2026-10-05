import { z } from 'zod';
import { defineIdempotency } from '../../src/idempotency/define-idempotency';

/** `status` has a default: what `work` returns may leave it out. */
export const orders = defineIdempotency({
	name: 'orders.create',
	key: (params: { user: string; key: string }) =>
		`${params.user}/${params.key}`,
	ttl: 3600,
	lease: 5_000,
	schema: z.object({
		orderId: z.string(),
		total: z.number().int(),
		status: z.string().default('placed'),
	}),
});

export const charges = defineIdempotency({
	name: 'payments.charge',
	key: (key: string) => key,
	ttl: 600,
	schema: z.object({ chargeId: z.string() }),
});

/** A type, exported beside them: the scope keeps only the definitions. */
export type Receipt = { orderId: string };
