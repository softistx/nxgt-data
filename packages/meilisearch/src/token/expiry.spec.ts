import { describe, expect, test } from 'bun:test';
import { Meilisearch } from 'meilisearch';
import { movies } from '../../test/movies';
import { defineIndex } from '../definition/define-index';
import { SearchIndexError } from '../errors/search-index-error';
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

describe('tenantToken expiresAt', () => {
	describe('expiresAt is refused before anything is signed', () => {
		const refused = async (expiresAt: Date | number | null | undefined) => {
			const error = await tenantToken({
				apiKey,
				// Not a UUID: had it been signed, the SDK would have thrown first.
				apiKeyUid: 'not-a-uuid',
				indexes: [movieIndex(), bindIndex(client, people)],
				searchRules: { movies: { filter: 'genres = scifi' }, people: null },
				expiresAt: expiresAt as Date,
			}).catch((e) => e);
			expect(error).toBeInstanceOf(SearchIndexError);
			expect(error.code).toBe('INVALID_EXPIRES_AT');
			expect(error.indexUid).toBe('movies,people');
			expect(error.message.includes(apiKey)).toBe(false);
			return error.message;
		};

		test('a missing expiresAt, which would last as long as the key', async () => {
			const missing =
				'tenantToken for "movies", "people": expiresAt is missing; it takes a Date, or whole seconds since the epoch';
			expect(await refused(undefined)).toBe(missing);
			// A JSON body's null is missing too.
			expect(await refused(null)).toBe(missing);
		});

		test('a past Date, or a past number of seconds', async () => {
			const past =
				'tenantToken for "movies", "people": expiresAt is in the past';
			expect(await refused(new Date(Date.now() - 1000))).toBe(past);
			expect(await refused(Math.floor(Date.now() / 1000) - 1)).toBe(past);
		});

		test('a number of milliseconds, which the server would accept for millennia', async () => {
			expect(await refused(Date.now() + 60_000)).toBe(
				'tenantToken for "movies", "people": expiresAt is a number of milliseconds; it takes seconds, or a Date',
			);
		});

		test('a fraction of a second, which the server cannot decode', async () => {
			expect(await refused(Date.now() / 1000 + 60.5)).toBe(
				'tenantToken for "movies", "people": expiresAt is not a whole number of seconds',
			);
		});

		test('an invalid Date, or a number that is not finite', async () => {
			expect(await refused(new Date('not a date'))).toBe(
				'tenantToken for "movies", "people": expiresAt is an invalid Date',
			);
			expect(await refused(Number.NaN)).toBe(
				'tenantToken for "movies", "people": expiresAt is neither a Date nor a finite number',
			);
		});

		test('a Date past the year 5138, as milliseconds times 1000 builds', async () => {
			expect(await refused(new Date(Date.now() * 1000))).toBe(
				'tenantToken for "movies", "people": expiresAt is a Date past the year 5138; was it built from milliseconds times 1000?',
			);
		});

		test('an object made to look like a Date, which has no time of its own', async () => {
			const fake = Object.setPrototypeOf(
				{ getTime: () => Date.now() + 3_600_000 },
				Date.prototype,
			);
			expect(await refused(fake)).toBe(
				'tenantToken for "movies", "people": expiresAt is neither a Date nor a finite number',
			);
		});
	});

	describe('a Date is read once, with the intrinsic getTime, into the seconds signed', () => {
		/** The `exp` the signed token carries, decoded from its payload. */
		const signedExp = async (expiresAt: Date) => {
			const token = await tenantToken({
				apiKey,
				apiKeyUid: crypto.randomUUID(),
				indexes: [movieIndex()],
				searchRules: { movies: null },
				expiresAt,
			});
			const payload = token.split('.')[1] ?? '';
			return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp;
		};

		test('a subclass whose getTime changes between calls', async () => {
			const time = Date.now() + 3_600_000;
			let calls = 0;
			class Shifty extends Date {
				override getTime() {
					calls += 1;
					return calls === 1 ? time : Number.NaN;
				}
			}
			expect(await signedExp(new Shifty(time))).toBe(Math.floor(time / 1000));
			expect(calls).toBe(0);
		});

		test('a real Date with an own getTime that lies', async () => {
			const time = Date.now() + 3_600_000;
			const date = new Date(time);
			let calls = 0;
			date.getTime = () => {
				calls += 1;
				return 1e20;
			};
			expect(await signedExp(date)).toBe(Math.floor(time / 1000));
			expect(calls).toBe(0);
		});

		test('an ordinary Date signs its whole seconds', async () => {
			const time = Date.now() + 3_600_500;
			expect(await signedExp(new Date(time))).toBe(Math.floor(time / 1000));
		});
	});
});
