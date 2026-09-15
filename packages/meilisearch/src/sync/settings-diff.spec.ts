import { describe, expect, test } from 'bun:test';
import { diffSettings, settingMatches } from './settings-diff';

describe('diffSettings', () => {
	test('is empty when the live settings already match', () => {
		expect(
			diffSettings(
				{ sortableAttributes: ['year', 'rating'], distinctAttribute: null },
				{
					sortableAttributes: ['rating', 'year'],
					distinctAttribute: null,
					stopWords: [],
				},
			),
		).toEqual({});
	});

	test('names only the settings that differ', () => {
		expect(
			diffSettings(
				{ sortableAttributes: ['year'], stopWords: ['the'] },
				{ sortableAttributes: ['year'], stopWords: [] },
			),
		).toEqual({ stopWords: ['the'] });
	});

	test('does not compare a setting the definition leaves out', () => {
		expect(diffSettings({}, { stopWords: ['the'] })).toEqual({});
		expect(
			diffSettings({ stopWords: undefined }, { stopWords: ['a'] }),
		).toEqual({});
	});
});

describe('settingMatches', () => {
	test('compares ordered lists in order, and the others as sets', () => {
		expect(
			settingMatches('rankingRules', ['words', 'typo'], ['typo', 'words']),
		).toBe(false);
		expect(settingMatches('searchableAttributes', ['a', 'b'], ['a', 'b'])).toBe(
			true,
		);
		expect(settingMatches('stopWords', ['the', 'a'], ['a', 'the'])).toBe(true);
		expect(settingMatches('filterableAttributes', ['a'], ['a', 'b'])).toBe(
			false,
		);
	});

	test('matches a merged object by the fields it sets', () => {
		const live = {
			enabled: true,
			minWordSizeForTypos: { oneTypo: 4, twoTypos: 9 },
			disableOnWords: [],
			disableOnAttributes: ['year'],
			disableOnNumbers: false,
		};
		expect(
			settingMatches(
				'typoTolerance',
				{ minWordSizeForTypos: { oneTypo: 4 } },
				live,
			),
		).toBe(true);
		expect(
			settingMatches(
				'typoTolerance',
				{ minWordSizeForTypos: { oneTypo: 5 } },
				live,
			),
		).toBe(false);
		expect(
			settingMatches(
				'faceting',
				{ sortFacetValuesBy: { genres: 'count' } },
				{
					maxValuesPerFacet: 100,
					sortFacetValuesBy: { '*': 'alpha', genres: 'count' },
				},
			),
		).toBe(true);
	});

	test('skips an embedder apiKey, which Meilisearch reads back masked', () => {
		expect(
			settingMatches(
				'embedders',
				{ default: { source: 'openAi', apiKey: 'sk-secret', model: 'm' } },
				{
					default: {
						source: 'openAi',
						apiKey: 'XXX...',
						model: 'm',
						dimensions: 3,
					},
				},
			),
		).toBe(true);
	});

	test('compares synonyms whatever their key order', () => {
		expect(
			settingMatches(
				'synonyms',
				{ a: ['b'], c: ['d'] },
				{ c: ['d'], a: ['b'] },
			),
		).toBe(true);
		expect(
			settingMatches('synonyms', { a: ['b'] }, { a: ['b'], c: ['d'] }),
		).toBe(false);
	});
});
