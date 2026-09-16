import type { Document } from 'mongodb';
import type { MongoCollectionOptions } from '../definition/collection-options';
import { DataError } from '../errors/data-error';

/** One option the live collection does not agree with the definition on. */
export interface OptionMismatch {
	/** The option, spelled as the definition spells it: `capped.size`. */
	option: string;
	/** What the definition asks for. */
	wanted: unknown;
	/** What the server reports, or `undefined` when it reports nothing. */
	live: unknown;
	/** Whether `collMod` can still change it on an existing collection. */
	mutable: boolean;
}

/**
 * Does the live value carry everything the definition asked for?
 *
 * Not equality, deliberately: MongoDB **fills its own defaults in**. A
 * `collation: { locale: 'fr', strength: 2 }` comes back with eleven keys and a
 * `version`, and a `timeseries` comes back with a `bucketMaxSpanSeconds` the
 * definition never mentioned. Comparing for equality would report a
 * difference on every single sync of a collection nothing had changed.
 */
function covers(live: unknown, wanted: unknown): boolean {
	if (Object.is(live, wanted)) return true;
	if (
		typeof wanted !== 'object' ||
		wanted === null ||
		typeof live !== 'object' ||
		live === null
	) {
		return false;
	}
	const l = live as Record<string, unknown>;
	return Object.entries(wanted as Record<string, unknown>).every(([k, v]) =>
		covers(l[k], v),
	);
}

/** Where one option lives on each side, and whether MongoDB can change it. */
interface OptionSpec {
	option: string;
	/** What the definition asks for, or `undefined` when it says nothing. */
	of: (wanted: MongoCollectionOptions) => unknown;
	/** What `listCollections` reports for it. */
	on: (live: Document) => unknown;
	mutable: boolean;
}

/**
 * Which options `collMod` can change, measured against mongod 8.2 rather than
 * assumed: `collMod` takes `cappedSize`, `cappedMax`, `expireAfterSeconds`,
 * a partial `timeseries` and `changeStreamPreAndPostImages`, and answers
 * "BSON field 'collMod.capped' is an unknown field" for the rest. Making a
 * collection capped, its collation and its clustered index are decided once,
 * at creation, and a definition that wants another one wants another
 * collection.
 */
const SPECS: readonly OptionSpec[] = [
	{
		option: 'capped',
		of: (w) => (w.capped === undefined ? undefined : true),
		on: (l) => (l.capped === true ? true : undefined),
		mutable: false,
	},
	{
		option: 'capped.size',
		of: (w) => w.capped?.size,
		on: (l) => l.size,
		mutable: true,
	},
	{
		option: 'capped.max',
		of: (w) => w.capped?.max,
		on: (l) => l.max,
		mutable: true,
	},
	{
		option: 'timeseries.timeField',
		of: (w) => w.timeseries?.timeField,
		on: (l) => timeseriesOf(l)?.timeField,
		mutable: false,
	},
	{
		option: 'timeseries.metaField',
		of: (w) => w.timeseries?.metaField,
		on: (l) => timeseriesOf(l)?.metaField,
		mutable: false,
	},
	{
		option: 'timeseries.granularity',
		of: (w) => w.timeseries?.granularity,
		on: (l) => timeseriesOf(l)?.granularity,
		mutable: true,
	},
	{
		option: 'timeseries.bucketMaxSpanSeconds',
		of: (w) => w.timeseries?.bucketMaxSpanSeconds,
		on: (l) => timeseriesOf(l)?.bucketMaxSpanSeconds,
		mutable: true,
	},
	{
		option: 'timeseries.bucketRoundingSeconds',
		of: (w) => w.timeseries?.bucketRoundingSeconds,
		on: (l) => timeseriesOf(l)?.bucketRoundingSeconds,
		mutable: true,
	},
	{
		option: 'expireAfterSeconds',
		of: (w) => w.expireAfterSeconds,
		on: (l) => l.expireAfterSeconds,
		mutable: true,
	},
	{
		option: 'collation',
		of: (w) => w.collation,
		on: (l) => l.collation,
		mutable: false,
	},
	{
		option: 'clusteredIndex',
		of: (w) => w.clusteredIndex,
		on: (l) => l.clusteredIndex,
		mutable: false,
	},
	{
		option: 'changeStreamPreAndPostImages',
		of: (w) => w.changeStreamPreAndPostImages,
		on: (l) => l.changeStreamPreAndPostImages,
		mutable: true,
	},
];

function timeseriesOf(live: Document): Record<string, unknown> | undefined {
	const value = live.timeseries;
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * What the live collection does not agree with the definition on.
 *
 * Only what the definition actually asks for is compared. An option it says
 * nothing about is left alone — the same rule as the indexes, where an index
 * someone added on purpose is not this package's to drop.
 */
export function diffCollectionOptions(
	wanted: MongoCollectionOptions,
	live: Document,
): OptionMismatch[] {
	const mismatches: OptionMismatch[] = [];
	for (const spec of SPECS) {
		const want = spec.of(wanted);
		if (want === undefined) continue;
		const has = spec.on(live);
		if (covers(has, want)) continue;
		mismatches.push({
			option: spec.option,
			wanted: want,
			live: has,
			mutable: spec.mutable,
		});
	}
	return mismatches;
}

/** The `collMod` fields that change the mutable mismatches, or none. */
export function collModForOptions(
	mismatches: readonly OptionMismatch[],
): Document {
	const command: Document = {};
	const timeseries: Document = {};
	for (const { option, wanted, mutable } of mismatches) {
		if (!mutable) continue;
		if (option === 'capped.size') command.cappedSize = wanted;
		else if (option === 'capped.max') command.cappedMax = wanted;
		else if (option.startsWith('timeseries.')) {
			timeseries[option.slice('timeseries.'.length)] = wanted;
		} else command[option] = wanted;
	}
	if (Object.keys(timeseries).length > 0) command.timeseries = timeseries;
	return command;
}

/**
 * The error an unchangeable difference raises, naming every one of them.
 *
 * It names what the server has and what the definition wants, because the
 * only way out is a decision — recreate the collection, migrate it, or put
 * the definition back — and none of those can be guessed here.
 */
export function immutableOptionsError(
	name: string,
	mismatches: readonly OptionMismatch[],
): DataError {
	const lines = mismatches.map(
		({ option, live, wanted }) =>
			`  ${option}: the collection has ${JSON.stringify(live ?? null)}, the ` +
			`definition asks for ${JSON.stringify(wanted)}`,
	);
	return new DataError(
		`sync: "${name}" already exists with options MongoDB cannot change:\n` +
			`${lines.join('\n')}\n` +
			'Recreate the collection with the options it needs, or put the ' +
			'definition back to what the collection is. `dryRun: true` lists ' +
			'every difference without throwing.',
		{ collection: name },
	);
}
