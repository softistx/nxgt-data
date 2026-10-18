import type { WiringContext } from './context';

/**
 * Closes the subscriptions first, then the clients.
 *
 * In that order, and not the other way: a subscription holds a connection
 * duplicated from the client, and unsubscribing on a closed client is an
 * error nobody asked for. Idempotent — `@nxgt/redis` memoises both closes,
 * and the set is emptied as it goes.
 */
export async function closeAll(ctx: WiringContext): Promise<void> {
	for (const subscription of [...ctx.subscriptions]) {
		ctx.subscriptions.delete(subscription);
		await subscription.close();
	}
	for (const instance of ctx.instances) {
		await instance.connection?.close();
	}
}
