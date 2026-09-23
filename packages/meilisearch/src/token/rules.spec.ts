import { describe, expect, test } from 'bun:test';
import { Meilisearch } from 'meilisearch';
import { movies } from '../../test/movies';
import { defineIndex } from '../definition/define-index';
import { bindIndex } from '../index/bind-index';
import { tenantToken } from './tenant-token';

// No server: every call here is refused, or signed, without sending anything.
// The key is a stand-in, and is only ever compared as a boolean.
const apiKey = 'a-stand-in-signing-key-never-printed';
const client = new Meilisearch({ host: 'http://127.0.0.1:1' });
const people = defineIndex<{ slug: string; country: string }>()({
	uid: 'people',
	primaryKey: 'slug',
});
const movieIndex = () => bindIndex(client, movies);
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

describe('tenantToken searchRules', () => {
	test('a rule under a uid that is none of the indexes’ is refused, not dropped', async () => {
		const error = await tenantToken({
			apiKey,
			// Not a UUID: had it been signed, the SDK would have thrown first.
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex()],
			searchRules: {
				movies: { filter: 'genres = scifi' },
				films: { filter: 'genres = scifi' },
			} as never,
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(
			'tenantToken for "movies": searchRules names "films", which is not the uid of any of its indexes',
		);
	});

	test('a rule inherited from a prototype is refused, not dropped', async () => {
		const inherited = Object.create({ movies: { filter: 'genres = scifi' } });
		const error = await tenantToken({
			apiKey,
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex()],
			searchRules: inherited,
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(
			'tenantToken for "movies": searchRules must be a plain object',
		);
	});

	test('a class instance is refused as not a plain object', async () => {
		class Rules {
			movies = { filter: 'genres = scifi' };
		}
		const error = await tenantToken({
			apiKey,
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex()],
			searchRules: new Rules(),
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(
			'tenantToken for "movies": searchRules must be a plain object',
		);
	});

	describe('an index with no rule is refused before anything is signed', () => {
		const refused = async (searchRules: unknown) => {
			const error = await tenantToken({
				apiKey,
				// Not a UUID: had it been signed, the SDK would have thrown first.
				apiKeyUid: 'not-a-uuid',
				indexes: [movieIndex(), bindIndex(client, people)],
				searchRules: searchRules as never,
				expiresAt: inAnHour(),
			}).catch((e) => e);
			expect(error).toBeInstanceOf(TypeError);
			expect(error.message.includes(apiKey)).toBe(false);
			// The message reports a shape, never a rule it was given.
			expect(error.message.includes('scifi')).toBe(false);
			return error.message;
		};

		test('one of two indexes left out', async () => {
			expect(await refused({ movies: { filter: 'genres = scifi' } })).toBe(
				'tenantToken for "movies", "people": searchRules has no rule for "people"; ' +
					'give each index { filter: … }, or null to search it with no filter',
			);
		});

		test('no searchRules at all, or null', async () => {
			const none =
				'tenantToken for "movies", "people": searchRules has no rule for "movies", "people"; ' +
				'give each index { filter: … }, or null to search it with no filter';
			expect(await refused(undefined)).toBe(none);
			expect(await refused(null)).toBe(none);
			expect(await refused({})).toBe(none);
		});

		test('a rule that is undefined, which is not null', async () => {
			expect(
				await refused({
					movies: { filter: 'genres = scifi' },
					people: undefined,
				}),
			).toBe(
				'tenantToken for "movies", "people": searchRules has no rule for "people"; ' +
					'give each index { filter: … }, or null to search it with no filter',
			);
		});
	});

	describe('an empty rule is refused before anything is signed', () => {
		const emptyPeople =
			'tenantToken for "movies", "people": searchRules has an empty rule for "people"; ' +
			'give it { filter: … }, or null to search it with no filter';
		const refused = async (rule: unknown) => {
			const error = await tenantToken({
				apiKey,
				// Not a UUID: had it been signed, the SDK would have thrown first.
				apiKeyUid: 'not-a-uuid',
				indexes: [movieIndex(), bindIndex(client, people)],
				searchRules: {
					movies: { filter: 'genres = scifi' },
					people: rule,
				} as never,
				expiresAt: inAnHour(),
			}).catch((e) => e);
			expect(error).toBeInstanceOf(TypeError);
			expect(error.message.includes(apiKey)).toBe(false);
			expect(error.message.includes('scifi')).toBe(false);
			return error.message;
		};

		test('a rule with no filter, or an undefined or null one', async () => {
			expect(await refused({})).toBe(emptyPeople);
			expect(await refused({ filter: undefined })).toBe(emptyPeople);
			expect(await refused({ filter: null })).toBe(emptyPeople);
		});

		test('a blank string, or an array of nothing', async () => {
			expect(await refused({ filter: '' })).toBe(emptyPeople);
			expect(await refused({ filter: '   ' })).toBe(emptyPeople);
			expect(await refused({ filter: [] })).toBe(emptyPeople);
			expect(await refused({ filter: ['', []] })).toBe(emptyPeople);
		});

		test('U+0085, which trim keeps and Meilisearch reads as blank, and U+FEFF, which \\s holds', async () => {
			expect(await refused({ filter: '\u0085' })).toBe(emptyPeople);
			expect(await refused({ filter: ['\u0085'] })).toBe(emptyPeople);
			expect(await refused({ filter: [['\u0085', ' \u0085']] })).toBe(
				emptyPeople,
			);
			expect(await refused({ filter: ['', '\u0085'] })).toBe(emptyPeople);
			expect(await refused({ filter: '\uFEFF \u0085' })).toBe(emptyPeople);
		});

		test('every empty rule is named', async () => {
			const error = await tenantToken({
				apiKey,
				apiKeyUid: 'not-a-uuid',
				indexes: [movieIndex(), bindIndex(client, people)],
				searchRules: { movies: { filter: [] }, people: {} } as never,
				expiresAt: inAnHour(),
			}).catch((e) => e);
			expect(error.message).toBe(
				'tenantToken for "movies", "people": searchRules has an empty rule for "movies", "people"; ' +
					'give it { filter: … }, or null to search it with no filter',
			);
		});
	});

	test('an index given twice with no rule is named once', async () => {
		const m = movieIndex();
		const error = await tenantToken({
			apiKey,
			apiKeyUid: 'not-a-uuid',
			indexes: [m, m],
			searchRules: {} as never,
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(
			'tenantToken for "movies": searchRules has no rule for "movies"; ' +
				'give each index { filter: … }, or null to search it with no filter',
		);
		expect(error.message.split('"movies"')).toHaveLength(3);
	});
});
