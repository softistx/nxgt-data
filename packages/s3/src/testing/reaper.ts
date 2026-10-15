import type { Subprocess } from 'bun';

/**
 * Kills the servers a process forgot to stop.
 *
 * The child is unref'd, so a script that never calls `stop()` still ends on
 * its own; its `exit` event then kills the server. A signal is the other way
 * out: with the child's parent gone, `weed` would be orphaned. The handlers
 * kill every live server, and when this module is the only listener for the
 * signal they end the process the way the default would (`128 + n`), so
 * nothing is swallowed. A process with its own handler keeps its own policy.
 *
 * One set of handlers serves every server; the last `stop()` removes them.
 */
const live = new Set<Subprocess>();
const SIGNALS = { SIGINT: 2, SIGTERM: 15 } as const;

function killAll(): void {
	for (const child of live) child.kill('SIGKILL');
}

const handlers = Object.fromEntries(
	Object.entries(SIGNALS).map(([name, number]) => [
		name,
		() => {
			killAll();
			if (process.listenerCount(name) === 1) process.exit(128 + number);
		},
	]),
) as Record<keyof typeof SIGNALS, () => void>;

/** Watches `child`; the function it returns stops watching. */
export function reapOnExit(child: Subprocess): () => void {
	if (live.size === 0) {
		process.on('exit', killAll);
		for (const name of Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]) {
			process.on(name, handlers[name]);
		}
	}
	live.add(child);
	return () => {
		live.delete(child);
		if (live.size > 0) return;
		process.off('exit', killAll);
		for (const name of Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]) {
			process.off(name, handlers[name]);
		}
	};
}
