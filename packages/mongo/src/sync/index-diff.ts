import type { IndexDescription, IndexDescriptionInfo } from 'mongodb';
import { canonical } from './canonical';

/**
 * What MongoDB fills a collation in with. It reads an index's collation back
 * canonical — every field, plus the ICU `version` — so a wanted collation is
 * compared against its own defaults, and `version` is left out: it changes
 * with the server's ICU, and recreating every index over it would be absurd.
 */
const COLLATION_DEFAULTS: Record<string, unknown> = {
	caseLevel: false,
	caseFirst: 'off',
	strength: 3,
	numericOrdering: false,
	alternate: 'non-ignorable',
	maxVariable: 'punct',
	normalization: false,
	backwards: false,
};

/**
 * Options the server does not read back when they are false, but does when
 * they were sent explicitly. Compared against the default either way.
 */
const OPTION_DEFAULTS: Record<string, unknown> = {
	unique: false,
	sparse: false,
	hidden: false,
	background: false,
};

/** Never part of an index's identity: the server's own bookkeeping. */
const IGNORED = new Set(['v', 'ns', 'key', 'name']);

type Fields = Record<string, unknown>;

function keyOf(index: IndexDescription | IndexDescriptionInfo): Fields {
	const key = index.key;
	return key instanceof Map ? Object.fromEntries(key) : { ...key };
}

/**
 * The name MongoDB gives an index that names none: every field and direction,
 * joined by `_`.
 */
export function indexNameOf(key: Fields): string {
	return Object.entries(key)
		.map(([field, direction]) => `${field}_${String(direction)}`)
		.join('_');
}

function canonicalCollation(value: unknown): unknown {
	if (typeof value !== 'object' || value === null) return value;
	const collation = value as Fields;
	const out: Fields = {};
	for (const [field, fallback] of Object.entries(COLLATION_DEFAULTS)) {
		out[field] = collation[field] ?? fallback;
	}
	out.locale = collation.locale;
	// `version` is the server's ICU version, never something to sync on.
	return out;
}

/** An index reduced to what makes two of them the same. */
export interface NormalizedIndex {
	name: string;
	/** In order: a compound index on `{a, b}` is not one on `{b, a}`. */
	key: Fields;
	options: Fields;
}

export function normalizeIndex(
	index: IndexDescription | IndexDescriptionInfo,
): NormalizedIndex {
	const key = keyOf(index);
	const options: Fields = {};
	for (const [name, value] of Object.entries(index)) {
		if (IGNORED.has(name) || value === undefined) continue;
		if (name === 'collation') {
			options.collation = canonicalCollation(value);
			continue;
		}
		if (OPTION_DEFAULTS[name] === value) continue;
		options[name] = value;
	}
	return { name: index.name ?? indexNameOf(key), key, options };
}

/** Are two indexes the same index, with the same options? */
export function indexMatches(
	wanted: IndexDescription,
	live: IndexDescriptionInfo,
): boolean {
	const a = normalizeIndex(wanted);
	const b = normalizeIndex(live);
	return (
		// The key's order counts, so it is compared as it was written.
		JSON.stringify(Object.entries(a.key)) ===
			JSON.stringify(Object.entries(b.key)) &&
		canonical(a.options) === canonical(b.options)
	);
}

export interface IndexDiff {
	/** Not on the server yet. */
	create: IndexDescription[];
	/**
	 * There under this name, with other options: MongoDB refuses to change
	 * one, so it is dropped and created again.
	 */
	recreate: IndexDescription[];
	/** Already as the definition wants it. */
	unchanged: string[];
	/** On the server and in no definition. `_id_` is never one. */
	extra: string[];
}

/**
 * What an index sync has to do. Indexes are matched by name, which is what
 * MongoDB keys them on: the same name with other options is error 86, and the
 * same key under another name is error 85.
 */
export function diffIndexes(
	wanted: readonly IndexDescription[],
	live: readonly IndexDescriptionInfo[],
): IndexDiff {
	const byName = new Map(
		live.map((index) => [normalizeIndex(index).name, index]),
	);
	const diff: IndexDiff = {
		create: [],
		recreate: [],
		unchanged: [],
		extra: [],
	};
	const named = new Set<string>();

	for (const index of wanted) {
		const name = normalizeIndex(index).name;
		named.add(name);
		const existing = byName.get(name);
		if (!existing) diff.create.push({ ...index, name });
		else if (indexMatches(index, existing)) diff.unchanged.push(name);
		else diff.recreate.push({ ...index, name });
	}

	for (const name of byName.keys()) {
		// The `_id_` index is created with the collection and cannot be dropped.
		if (name !== '_id_' && !named.has(name)) diff.extra.push(name);
	}
	return diff;
}
