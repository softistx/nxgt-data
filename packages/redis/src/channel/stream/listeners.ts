import type { Listener, StreamContext } from './context';
import { release } from './subscription';

export function deliver<T>(ctx: StreamContext<T>, message: T): void {
	for (const listener of ctx.byKey.get(ctx.keyOf(message)) ?? []) {
		listener.push(message);
	}
}

export function add<T>(ctx: StreamContext<T>, listener: Listener<T>): void {
	const set = ctx.byKey.get(listener.key) ?? new Set<Listener<T>>();
	ctx.byKey.set(listener.key, set);
	set.add(listener);
	ctx.count += 1;
}

/** Removes a listener; the last one out closes the shared subscription. */
export function remove<T>(ctx: StreamContext<T>, listener: Listener<T>): void {
	const set = ctx.byKey.get(listener.key);
	if (set === undefined || !set.delete(listener)) return;
	ctx.count -= 1;
	if (set.size === 0) ctx.byKey.delete(listener.key);
	if (ctx.count === 0) void release(ctx);
}

export function stopAll<T>(ctx: StreamContext<T>): void {
	for (const set of [...ctx.byKey.values()]) {
		for (const listener of set) listener.stop();
	}
	ctx.byKey.clear();
	ctx.count = 0;
}
