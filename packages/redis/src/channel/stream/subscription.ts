import type { StreamContext } from './context';
import { deliver } from './listeners';

/** Opens the process's one subscription. A failed open is forgotten. */
export async function open<T>(ctx: StreamContext<T>): Promise<void> {
	if (ctx.opened !== undefined || ctx.closed) return;
	const attempt = ctx.source.subscribe((message) => deliver(ctx, message));
	ctx.opened = attempt;
	try {
		const subscription = await attempt;
		if (ctx.opened === attempt) ctx.live = subscription;
	} catch {
		if (ctx.opened === attempt) ctx.opened = undefined;
	}
}

/**
 * Forgets the subscription and closes it. An open one is awaited; one still
 * in flight is not: against an unreachable server the attempt takes ~31 s to
 * fail, so the late subscription is closed in the background if and when it
 * resolves.
 */
export async function release<T>(ctx: StreamContext<T>): Promise<void> {
	const pending = ctx.opened;
	const live = ctx.live;
	ctx.opened = undefined;
	ctx.live = undefined;
	if (pending === undefined) return;
	if (live !== undefined) {
		await live.close().catch(() => {});
		return;
	}
	pending.then(
		(subscription) => subscription.close().catch(() => {}),
		() => {
			// It failed to open: nothing to close.
		},
	);
}
