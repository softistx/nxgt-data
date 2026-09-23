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
const movieIndex = () => bindIndex(client, movies);
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

describe('a uid that is not an index uid is refused, since a rule key is a pattern', () => {
	const notAUid =
		'tenantToken: an index uid is not a valid Meilisearch uid ' +
		'(letters, digits, - and _ only), and a * in it would widen the token ' +
		'to other indexes';
	/**
	 * The refusal for an index under `uid`, with a null rule. `defineIndex`
	 * and `bindIndex` refuse such a uid first, so the index is a bound one
	 * whose `uid` was replaced after: tenantToken's own check is what is left.
	 */
	const refused = async (uid: string) => {
		const index = bindIndex(
			client,
			defineIndex<{ slug: string }>()({
				uid: 'docs' as string,
				primaryKey: 'slug',
			}),
		);
		(index as { uid: string }).uid = uid;
		const error = await tenantToken({
			apiKey,
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex(), index],
			searchRules: { movies: { filter: 'genres = scifi' }, [uid]: null },
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message.includes(apiKey)).toBe(false);
		return error.message;
	};

	test('*, which would reach every index', async () => {
		expect(await refused('*')).toBe(notAUid);
	});

	test('movies*, which would reach every index it prefixes', async () => {
		expect(await refused('movies*')).toBe(notAUid);
		// The message names no uid: one built from a request stays out of logs.
		expect((await refused('docs_acme*')).includes('acme')).toBe(false);
	});

	test('an empty uid, or one with a character no uid has', async () => {
		expect(await refused('')).toBe(notAUid);
		expect(await refused('docs acme')).toBe(notAUid);
	});

	test('a rule keyed by a pattern beside valid indexes is an unmatched key', async () => {
		const error = await tenantToken({
			apiKey,
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex()],
			searchRules: { movies: null, 'movies*': null } as never,
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(
			'tenantToken for "movies": searchRules names "movies*", which is not the uid of any of its indexes',
		);
	});

	test('the bound is the server’s: 400 characters sign, 401 do not', async () => {
		const index = bindIndex(
			client,
			defineIndex<{ slug: string }>()({
				uid: 'a'.repeat(400),
				primaryKey: 'slug',
			}),
		);
		const token = await tenantToken({
			apiKey,
			apiKeyUid: crypto.randomUUID(),
			indexes: [index],
			searchRules: { ['a'.repeat(400)]: null },
			expiresAt: inAnHour(),
		});
		expect(typeof token).toBe('string');
		expect(await refused('a'.repeat(401))).toBe(notAUid);
	});

	test('a lookalike, a trailing newline, or a uid that is not a string', async () => {
		expect(await refused('movies\uFF0A')).toBe(notAUid);
		expect(await refused('movies\n')).toBe(notAUid);
		const error = await tenantToken({
			apiKey,
			apiKeyUid: 'not-a-uuid',
			indexes: [{ uid: 42 } as never],
			searchRules: {} as never,
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(notAUid);
	});
});
