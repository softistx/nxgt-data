import { openRedis } from '@nxgt/redis';
import { type AppRedis, config } from './redis';

/** Queues a welcome mail; the tenant is the group, so a busy tenant waits its turn. */
export function addWelcome(redis: AppRedis, tenantId: string, to: string) {
	return redis.queues.mails.add(
		{ kind: 'welcome', tenantId, to },
		{ group: tenantId },
	);
}

// bun src/producer.ts acme ada@acme.test
if (import.meta.main) {
	const [tenantId, to] = Bun.argv.slice(2);
	if (!tenantId || !to) throw new Error('usage: producer <tenantId> <to>');
	const redis = await openRedis(config);
	console.log('queued', (await addWelcome(redis, tenantId, to)).id);
	await redis.close();
}
