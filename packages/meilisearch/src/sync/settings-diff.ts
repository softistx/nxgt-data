import type { Settings } from 'meilisearch';

/**
 * The settings as something *wants* them, rather than as the server reports
 * them: the same fields, with every list `readonly`.
 *
 * `defineIndex` types a definition's `settings` that way — `sortableAttributes:
 * ['year']` is inferred as `readonly ['year']`, which is what makes `SortableOf`
 * work — and the SDK's `Settings` has mutable arrays. So `diffSettings(
 * movies.settings, live)`, the obvious thing to write, did not compile, and
 * even this package had to cast on its way in.
 */
export type WantedSettings = DeepReadonly<Settings>;

/**
 * Every list `readonly`, and every value allowed to be `undefined`, at every
 * depth.
 *
 * The depth is not a convenience: `IndexSettings` writes
 * `faceting.sortFacetValuesBy` as a `Partial<Record<…>>`, whose values carry
 * `undefined` where the SDK's own type does not — so without it a definition
 * does not go in at all, which is the whole point of this type.
 *
 * `withoutUndefined` below then keeps that widening from reaching the server
 * as a field. Measured, and worth stating exactly, because it is narrower
 * than it first looks: the four objects in `MERGED` come out `{}` either way,
 * since `contains` skips an `undefined` field; and `JSON.stringify` drops an
 * `undefined` value, so the request on the wire was already the same. What
 * the strip changes is the object handed to the SDK — `{ features:
 * undefined }` and `{}` are the same request but not the same object, and a
 * field the caller did not state should not be in either.
 */
type DeepReadonly<T> = T extends readonly (infer Element)[]
	? readonly DeepReadonly<Element>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> | undefined }
		: T;

/** Lists whose order is part of their meaning. */
const ORDERED = new Set<string>([
	'searchableAttributes',
	'displayedAttributes',
	'rankingRules',
]);

/**
 * Objects Meilisearch merges into its defaults: a definition that sets
 * `typoTolerance.enabled` reads back with every other field filled in, so it
 * matches when what it sets is there.
 */
const MERGED = new Set<string>([
	'typoTolerance',
	'faceting',
	'pagination',
	'embedders',
]);

/** JSON with sorted object keys, so key order never counts. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, inner) =>
		inner && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
				)
			: inner,
	);
}

/** An array as a set: its canonical elements, sorted. */
function asSet(value: unknown): unknown {
	return Array.isArray(value) ? value.map(canonical).sort() : value;
}

/**
 * Does `live` hold everything `wanted` sets? Objects by their keys, arrays as
 * sets, the rest by equality. An `apiKey` is skipped: Meilisearch reads back
 * an embedder's key masked, so it would never match.
 */
function contains(wanted: unknown, live: unknown): boolean {
	if (Array.isArray(wanted)) {
		return canonical(asSet(wanted)) === canonical(asSet(live));
	}
	if (wanted && typeof wanted === 'object') {
		if (!live || typeof live !== 'object' || Array.isArray(live)) return false;
		return Object.entries(wanted).every(
			([key, value]) =>
				key === 'apiKey' ||
				value === undefined ||
				contains(value, (live as Record<string, unknown>)[key]),
		);
	}
	return wanted === live;
}

/** Does the live value of one setting already match the wanted one? */
export function settingMatches(
	name: string,
	wanted: unknown,
	live: unknown,
): boolean {
	if (ORDERED.has(name)) return canonical(wanted) === canonical(live);
	if (MERGED.has(name)) return contains(wanted, live);
	return canonical(asSet(wanted)) === canonical(asSet(live));
}

/**
 * The settings of `wanted` that `live` does not match yet: what an update
 * must send, and nothing else. A setting `wanted` leaves out is not compared.
 */
export function diffSettings(wanted: WantedSettings, live: Settings): Settings {
	const diff: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(wanted)) {
		if (value === undefined) continue;
		if (!settingMatches(name, value, (live as Record<string, unknown>)[name])) {
			// Stripped, not forwarded as it came: an `undefined` nested in a
			// setting is a field the caller did not state, and the object
			// without it is how Meilisearch is told to leave that field alone.
			diff[name] = withoutUndefined(value);
		}
	}
	return diff as Settings;
}

/** The value with every `undefined` field dropped, at every depth. */
function withoutUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutUndefined);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, inner]) => inner !== undefined)
			.map(([key, inner]) => [key, withoutUndefined(inner)]),
	);
}
