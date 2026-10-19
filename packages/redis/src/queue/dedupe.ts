import { durationMs } from './duration';

/** The longest a job id or a dedupe key may be. */
export const MAX_NAME = 256;

/** The text of the refusal for a name: an id or a dedupe key. */
export const NAME_RULE = `a string of 1 to ${MAX_NAME} characters without braces, which are a hash tag`;

/**
 * Whether `value` is usable as a job id or a dedupe key: a string of 1 to
 * {@link MAX_NAME} characters without braces, which Redis Cluster reads as a
 * hash tag.
 */
export function isName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_NAME &&
		!value.includes('{') &&
		!value.includes('}')
	);
}

/**
 * How long a debounce key outlives its wait, in ms. Only a memory bound:
 * `ADD` decides by the named job's state, never by whether the key is there.
 */
const DEBOUNCE_GRACE_MS = 86_400_000;

/** What a script is given for one job's `debounce` or `throttle`. */
export type ResolvedDedupe = {
	/** `''` for neither, `'d'` debounce, `'t'` throttle: as the script reads it. */
	mode: '' | 'd' | 't';
	key: string;
	/** The key's PX in ms; `0` when there is no key. */
	ttlMs: number;
	/** A debounce's wait, which is the job's delay; `0` otherwise. */
	waitMs: number;
};

const NONE: ResolvedDedupe = { mode: '', key: '', ttlMs: 0, waitMs: 0 };

/**
 * Checks `add`'s `debounce` and `throttle` and resolves them. Each refusal is
 * a bare `TypeError` naming the call, the queue and the option, as
 * `resolveAdd`'s own; no message prints a value.
 */
export function resolveDedupe(
	options: object | undefined,
	call: string,
	queue: string,
): ResolvedDedupe {
	const { debounce, throttle, id, delay, at } = (options ?? {}) as Record<
		string,
		unknown
	>;
	if (debounce === undefined && throttle === undefined) return NONE;
	const refuse = (what: string): never => {
		throw new TypeError(`${call} on "${queue}": ${what}`);
	};
	if (debounce !== undefined && throttle !== undefined) {
		refuse('debounce and throttle cannot be combined; give one');
	}
	const name = debounce !== undefined ? 'debounce' : 'throttle';
	const span = debounce !== undefined ? 'wait' : 'window';
	const given = (debounce ?? throttle) as Record<string, unknown> | null;
	if (id !== undefined) {
		refuse(`${name} and id cannot be combined; the key names the job`);
	}
	if (debounce !== undefined) {
		for (const [option, value] of [
			['delay', delay],
			['at', at],
		] as const) {
			if (value !== undefined) {
				refuse(
					`debounce and ${option} cannot be combined; wait sets the run time`,
				);
			}
		}
	}
	if (typeof given !== 'object' || given === null) {
		return refuse(`${name} is an object { key, ${span} }`);
	}
	if (!isName(given['key'])) refuse(`${name}.key is ${NAME_RULE}`);
	const ms = durationMs(given[span]);
	if (ms === undefined || ms < 1) {
		refuse(
			`${name}.${span} is at least 1 millisecond, as a whole number or a string such as '10m'`,
		);
	}
	const spanMs = ms as number;
	return debounce !== undefined
		? {
				mode: 'd',
				key: given['key'] as string,
				ttlMs: spanMs + DEBOUNCE_GRACE_MS,
				waitMs: spanMs,
			}
		: { mode: 't', key: given['key'] as string, ttlMs: spanMs, waitMs: 0 };
}
