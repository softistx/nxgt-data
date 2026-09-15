import type { Settings } from 'meilisearch';

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
export function diffSettings(wanted: Settings, live: Settings): Settings {
	const diff: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(wanted)) {
		if (value === undefined) continue;
		if (!settingMatches(name, value, (live as Record<string, unknown>)[name])) {
			diff[name] = value;
		}
	}
	return diff as Settings;
}
