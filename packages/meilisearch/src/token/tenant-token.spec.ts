import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { type Key, Meilisearch, MeilisearchApiError } from 'meilisearch';
import { generateTenantToken } from 'meilisearch/token';
import { movies, sampleMovies } from '../../test/movies';
import { startMeilisearch, type TestServer } from '../../test/server';
import { defineIndex } from '../definition/define-index';
import { bindIndex } from '../index/bind-index';
import { multiSearch } from '../search/multi-search';
import { tenantToken } from './tenant-token';

// No key, token or master key is ever printed here: a failing `expect` prints
// what it received, so a key is only ever compared as a boolean.

const people = defineIndex<{ slug: string; country: string }>()({
	uid: 'people',
	primaryKey: 'slug',
	settings: { filterableAttributes: ['country'] },
});

let t: TestServer;
let key: Key;

beforeAll(async () => {
	t = await startMeilisearch();
}, 60_000);
beforeEach(async () => {
	await t.reset();
	const movieIndex = bindIndex(t.client, movies);
	const peopleIndex = bindIndex(t.client, people);
	await movieIndex.sync();
	await peopleIndex.sync();
	await movieIndex.add(sampleMovies, { wait: true });
	await peopleIndex.add([{ slug: 'ridley-scott', country: 'UK' }], {
		wait: true,
	});
	// A search key on the movies index only, as a tenant token wants.
	key = await t.client.createKey({
		actions: ['search'],
		indexes: ['movies'],
		expiresAt: null,
	});
});
afterAll(() => t.stop());

/** A client that searches with the token, and nothing else. */
const as = (token: string) => new Meilisearch({ host: t.host, apiKey: token });
const movieIndex = () => bindIndex(t.client, movies);
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

describe('tenantToken', () => {
	test('a search with the token sees only what its filter matches', async () => {
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [movieIndex()],
			searchRules: { movies: { filter: 'genres = scifi' } },
			expiresAt: inAnHour(),
		});
		const scoped = bindIndex(as(token), movies);
		const all = await scoped.search('', { sort: ['year:asc'] });
		expect(all.hits.map((m) => m.id)).toEqual([1, 2, 4]);
		// The rule is added to the search's own filter, not replaced by it.
		const narrowed = await scoped.search('', { filter: 'year > 1990' });
		expect(narrowed.hits.map((m) => m.id)).toEqual([4]);
		// And it holds in a multi-search too.
		const [viaMulti] = await multiSearch(as(token), [{ index: scoped }]);
		expect(viaMulti.hits.map((m) => m.id).sort()).toEqual([1, 2, 4]);
	});

	test('an index whose rule is null is searched with no filter', async () => {
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [movieIndex()],
			searchRules: { movies: null },
			expiresAt: inAnHour(),
		});
		const result = await as(token).index('movies').search('');
		expect(result.hits).toHaveLength(4);
	});

	test('an index the token was not given is refused by the server', async () => {
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [movieIndex()],
			searchRules: { movies: null },
			expiresAt: inAnHour(),
		});
		const error = await as(token)
			.index('people')
			.search('')
			.catch((e) => e);
		expect(error).toBeInstanceOf(MeilisearchApiError);
		expect(error.cause.code).toBe('invalid_api_key');
		expect(error.message).toBe(
			'The provided tenant token cannot acces the index `people`, allowed indexes are ["movies"].',
		);
	});

	test('an index the key does not cover is refused by the server', async () => {
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [bindIndex(t.client, people)],
			searchRules: { people: null },
			expiresAt: inAnHour(),
		});
		const error = await as(token)
			.index('people')
			.search('')
			.catch((e) => e);
		expect(error).toBeInstanceOf(MeilisearchApiError);
		expect(error.cause.code).toBe('invalid_api_key');
		expect(error.message).toBe(
			'The API key used to generate this tenant token cannot acces the index `people`.',
		);
	});

	test('an expired token is refused by the server', async () => {
		// tenantToken refuses to sign one: the SDK's own call signs it here.
		const token = await generateTenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			searchRules: { movies: null },
			expiresAt: Math.floor(Date.now() / 1000) - 60,
		});
		const error = await as(token)
			.index('movies')
			.search('')
			.catch((e) => e);
		expect(error).toBeInstanceOf(MeilisearchApiError);
		expect(error.cause.code).toBe('invalid_api_key');
		expect(error.response.status).toBe(403);
		expect(error.message).toMatch(
			/^Tenant token expired\. Was valid up to `\d+` and we're now `\d+`\.$/,
		);
	});

	test('a rule on an attribute that is not filterable fails every search with the token', async () => {
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [movieIndex()],
			searchRules: { movies: { filter: 'rating > 8' } },
			expiresAt: inAnHour(),
		});
		const error = await as(token)
			.index('movies')
			.search('')
			.catch((e) => e);
		expect(error).toBeInstanceOf(MeilisearchApiError);
		expect(error.cause.code).toBe('invalid_search_filter');
		expect(error.response.status).toBe(400);
		expect(error.message).toStartWith(
			'Index `movies`: Attribute `rating` is not filterable.',
		);
	});

	test('a deleted key takes its tokens with it', async () => {
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [movieIndex()],
			searchRules: { movies: null },
			expiresAt: inAnHour(),
		});
		await t.client.deleteKey(key.uid);
		const error = await as(token)
			.index('movies')
			.search('')
			.catch((e) => e);
		expect(error.message).toBe('The provided API key is invalid.');
	});

	test('a null-prototype object is a plain object, and its rules apply', async () => {
		const rules = Object.assign(Object.create(null), {
			movies: { filter: 'genres = scifi' },
		});
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [movieIndex()],
			searchRules: rules,
			expiresAt: inAnHour(),
		});
		const result = await as(token).index('movies').search('');
		expect(result.hits.map((m) => m.id).sort()).toEqual([1, 2, 4]);
	});

	test('the plain copy is what is signed: a nested array filter still filters', async () => {
		const token = await tenantToken({
			apiKey: key.key,
			apiKeyUid: key.uid,
			indexes: [movieIndex()],
			searchRules: { movies: { filter: [['genres = scifi', 'year < 0']] } },
			expiresAt: inAnHour(),
		});
		const result = await as(token).index('movies').search('');
		expect(result.hits.map((m) => m.id).sort()).toEqual([1, 2, 4]);
	});

	test('a rebuild’s next index takes a rule under its runtime uid', async () => {
		const index = movieIndex();
		await index.sync();
		const all = await t.client.createKey({
			actions: ['search'],
			indexes: ['*'],
			expiresAt: null,
		});
		let hits: number[] = [];
		await index.rebuild(async (next) => {
			await next.add(sampleMovies, { wait: true });
			const token = await tenantToken({
				apiKey: all.key,
				apiKeyUid: all.uid,
				indexes: [next],
				searchRules: { [next.uid]: { filter: 'genres = scifi' } },
				expiresAt: inAnHour(),
			});
			const result = await as(token).index(next.uid).search('');
			hits = result.hits.map((m) => m.id as number).sort();
		});
		expect(hits).toEqual([1, 2, 4]);
	});

	test('a key uid that is not a UUID is the SDK’s own refusal', async () => {
		const error = await tenantToken({
			apiKey: key.key,
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex()],
			searchRules: { movies: null },
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error.message).toBe('the uid of your key is not a valid UUIDv4');
	});
});
