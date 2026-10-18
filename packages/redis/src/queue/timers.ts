/**
 * The longest a JavaScript timer waits, in milliseconds (2^31 - 1, about 24.8
 * days): a longer one fires at once. A run's `timeout`, `finished`'s
 * `timeout` and `close`'s `grace` above it wait this long instead.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * A wait as a timer can hold it: capped at {@link MAX_TIMER_MS}, floored at 0
 * so a negative value from a foreign write never fires at once as a timeout
 * would; `undefined` stays no limit.
 */
export function clampTimeout(ms: number): number;
export function clampTimeout(ms: number | undefined): number | undefined;
export function clampTimeout(ms: number | undefined): number | undefined {
	return ms === undefined ? undefined : Math.min(Math.max(ms, 0), MAX_TIMER_MS);
}
