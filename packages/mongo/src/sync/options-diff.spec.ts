import { describe, expect, test } from 'bun:test';
import {
	collModForOptions,
	diffCollectionOptions,
	immutableOptionsError,
} from './options-diff';

/** `collation`, as mongod 8.2 reports it back for `{ locale, strength }`. */
const LIVE_COLLATION = {
	locale: 'fr',
	caseLevel: false,
	caseFirst: 'off',
	strength: 2,
	numericOrdering: false,
	alternate: 'non-ignorable',
	maxVariable: 'punct',
	normalization: false,
	backwards: false,
	version: '57.1',
};

describe('diffCollectionOptions', () => {
	test('a collection that agrees has no difference', () => {
		expect(
			diffCollectionOptions(
				{ capped: { size: 4096, max: 10 } },
				{ capped: true, size: 4096, max: 10 },
			),
		).toEqual([]);
	});

	test('the defaults the server fills in are not differences', () => {
		// The definition asked for two keys and got eleven back. Comparing the
		// two for equality would report a difference on every sync of a
		// collection nobody had touched.
		expect(
			diffCollectionOptions(
				{ collation: { locale: 'fr', strength: 2 } },
				{ collation: LIVE_COLLATION },
			),
		).toEqual([]);
	});

	test('a bucket span the server computed is not a difference', () => {
		expect(
			diffCollectionOptions(
				{ timeseries: { timeField: 'at', granularity: 'seconds' } },
				{
					timeseries: {
						timeField: 'at',
						granularity: 'seconds',
						bucketMaxSpanSeconds: 3600,
					},
				},
			),
		).toEqual([]);
	});

	test('an option the definition says nothing about is left alone', () => {
		// The same rule as the indexes: what someone set on purpose is not
		// this package's to undo.
		expect(
			diffCollectionOptions(
				{},
				{ capped: true, size: 4096, collation: LIVE_COLLATION },
			),
		).toEqual([]);
	});

	test('making an existing collection capped cannot be done', () => {
		const [mismatch, ...rest] = diffCollectionOptions(
			{ capped: { size: 4096 } },
			{},
		);
		expect(mismatch).toEqual({
			option: 'capped',
			wanted: true,
			live: undefined,
			mutable: false,
		});
		// The size difference rides along, and it *is* changeable.
		expect(rest).toEqual([
			{ option: 'capped.size', wanted: 4096, live: undefined, mutable: true },
		]);
	});

	test('a size, a TTL and a granularity can still be changed', () => {
		const mismatches = diffCollectionOptions(
			{
				capped: { size: 8192, max: 20 },
				expireAfterSeconds: 60,
				timeseries: { timeField: 'at', granularity: 'minutes' },
			},
			{
				capped: true,
				size: 4096,
				max: 10,
				expireAfterSeconds: 3600,
				timeseries: { timeField: 'at', granularity: 'seconds' },
			},
		);
		expect(mismatches.every((m) => m.mutable)).toBe(true);
		expect(mismatches.map((m) => m.option)).toEqual([
			'capped.size',
			'capped.max',
			'timeseries.granularity',
			'expireAfterSeconds',
		]);
	});

	test('a collation or a clustered index is decided once', () => {
		expect(
			diffCollectionOptions(
				{ collation: { locale: 'en' } },
				{ collation: LIVE_COLLATION },
			),
		).toEqual([
			{
				option: 'collation',
				wanted: { locale: 'en' },
				live: LIVE_COLLATION,
				mutable: false,
			},
		]);
		expect(
			diffCollectionOptions(
				{ clusteredIndex: { key: { _id: 1 }, unique: true } },
				{},
			).map((m) => m.mutable),
		).toEqual([false]);
	});

	test('a time field is fixed, and says so', () => {
		expect(
			diffCollectionOptions(
				{ timeseries: { timeField: 'recordedAt' } },
				{ timeseries: { timeField: 'at', granularity: 'seconds' } },
			),
		).toEqual([
			{
				option: 'timeseries.timeField',
				wanted: 'recordedAt',
				live: 'at',
				mutable: false,
			},
		]);
	});
});

describe('collModForOptions', () => {
	test('names the fields collMod takes, not the definition’s', () => {
		const command = collModForOptions([
			{ option: 'capped.size', wanted: 8192, live: 4096, mutable: true },
			{ option: 'capped.max', wanted: 20, live: 10, mutable: true },
			{ option: 'expireAfterSeconds', wanted: 60, live: 3600, mutable: true },
		]);
		expect(command).toEqual({
			cappedSize: 8192,
			cappedMax: 20,
			expireAfterSeconds: 60,
		});
	});

	test('the time-series fields go back under one key', () => {
		expect(
			collModForOptions([
				{
					option: 'timeseries.granularity',
					wanted: 'minutes',
					live: 'seconds',
					mutable: true,
				},
				{
					option: 'timeseries.bucketMaxSpanSeconds',
					wanted: 120,
					live: 3600,
					mutable: true,
				},
			]),
		).toEqual({
			timeseries: { granularity: 'minutes', bucketMaxSpanSeconds: 120 },
		});
	});

	test('leaves out what it cannot change', () => {
		expect(
			collModForOptions([
				{ option: 'capped', wanted: true, live: undefined, mutable: false },
			]),
		).toEqual({});
	});
});

describe('immutableOptionsError', () => {
	test('names the option, what is there and what is wanted', () => {
		const error = immutableOptionsError('events', [
			{ option: 'capped', wanted: true, live: undefined, mutable: false },
			{
				option: 'collation',
				wanted: { locale: 'en' },
				live: { locale: 'fr' },
				mutable: false,
			},
		]);
		expect(error.message).toContain('"events" already exists');
		expect(error.message).toContain('capped: the collection has null');
		expect(error.message).toContain('the definition asks for true');
		expect(error.message).toContain(
			'collation: the collection has {"locale":"fr"}',
		);
		expect(error.message).toContain('dryRun');
		expect(error.collection).toBe('events');
	});
});
