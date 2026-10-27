import type { StreamContext } from './context';
import { deliver } from './listeners';

/** Opens the process's one subscription. A failed open is forgotten. */
export async function open<T>(ctx: StreamContext<T>): Promise<void> {
	if (ctx.opened !== undefined || ctx.closed) return;
	const attempt = ctx.source.subscribe((message) => deliver(ctx, message));
	ctx.opened = attempt;
	try {
		await attempt;
	} catch {
		if (ctx.opened === attempt) ctx.opened = undefined;
	}
}

/** Forgets the subscription and closes it, once it has finished opening. */
export async function release<T>(ctx: StreamContext<T>): Promise<void> {
	const pending = ctx.opened;
	ctx.opened = undefined;
	if (pending === undefined) return;
	try {
		await (await pending).close();
	} catch {
		// It failed to open (nothing to close) or to close (nothing to do).
	}
}
