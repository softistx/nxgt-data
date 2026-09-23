import { describe, expect, test } from 'bun:test';
import { Meilisearch } from 'meilisearch';
import { movies } from '../../test/movies';
import { bindIndex } from '../index/bind-index';
import { tenantToken } from './tenant-token';

// No server: every call here is refused, or signed, without sending anything.
// The key is a stand-in, and is only ever compared as a boolean.
const apiKey = 'a-stand-in-signing-key-never-printed';
const client = new Meilisearch({ host: 'http://127.0.0.1:1' });
const movieIndex = () => bindIndex(client, movies);
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

// The rule is copied, and the copy checked and signed: each case below
// signed an unfiltered token when the check read the caller's object.

describe('a rule is read once, into a plain copy, and refused unless plain', () => {
	const give = '; give it { filter: … }, or null to search it with no filter';
	/** The message for `movies`' rule, or a failure if it was signed. */
	const refused = async (rule: unknown) => {
		const error = await tenantToken({
			apiKey,
			// Not a UUID: had it been signed, the SDK would have thrown first.
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex()],
			searchRules: { movies: rule } as never,
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message.includes(apiKey)).toBe(false);
		expect(error.message.includes('scifi')).toBe(false);
		return error.message;
	};
	const on = (problem: string) =>
		`tenantToken for "movies": searchRules has a rule for "movies" ${problem}${give}`;

	test('a class instance whose filter is a getter', async () => {
		class GetterRule {
			get filter() {
				return 'genres = scifi';
			}
		}
		expect(await refused(new GetterRule())).toBe(
			on('that is not a plain object'),
		);
	});

	test('a toJSON on the rule, or on its filter', async () => {
		expect(
			await refused({ filter: 'genres = scifi', toJSON: () => null }),
		).toBe(on('that has a toJSON'));
		const filter = Object.assign(['genres = scifi'], { toJSON: () => null });
		expect(await refused({ filter })).toBe(on('whose filter has a toJSON'));
	});

	test('a filter that is not a string or an array of strings', async () => {
		expect(await refused({ filter: Number.NaN })).toBe(
			on('whose filter is a number'),
		);
		expect(await refused({ filter: Number.POSITIVE_INFINITY })).toBe(
			on('whose filter is a number'),
		);
		expect(await refused({ filter: () => 'genres = scifi' })).toBe(
			on('whose filter is a function'),
		);
		expect(await refused({ filter: Symbol('scifi') })).toBe(
			on('whose filter is a symbol'),
		);
		expect(await refused({ filter: ['genres = scifi', 1] })).toBe(
			on('whose filter holds a number'),
		);
		expect(await refused({ filter: [[['genres = scifi']]] })).toBe(
			on('whose filter holds an array'),
		);
	});

	test('an inherited filter, or one that is not enumerable', async () => {
		expect(await refused(Object.create({ filter: 'genres = scifi' }))).toBe(
			on('that is not a plain object'),
		);
		const hidden = Object.defineProperty({}, 'filter', {
			value: 'genres = scifi',
			enumerable: false,
		});
		expect(await refused(hidden)).toBe(on('whose filter is not enumerable'));
	});

	test('a getter that changes between reads, on the filter or the rule', async () => {
		let reads = 0;
		const changing = {
			get filter() {
				reads += 1;
				return reads === 1 ? 'genres = scifi' : '';
			},
		};
		expect(await refused(changing)).toBe(on('whose filter is a getter'));
		// Neither getter was called: nothing was read twice.
		const rules = {
			get movies() {
				reads += 1;
				return reads === 1 ? { filter: 'genres = scifi' } : {};
			},
		};
		const error = await tenantToken({
			apiKey,
			apiKeyUid: 'not-a-uuid',
			indexes: [movieIndex()],
			searchRules: rules as never,
			expiresAt: inAnHour(),
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(on('that is a getter'));
		expect(reads).toBe(0);
	});

	test('an array given as a rule, whose filter would be Array.prototype.filter', async () => {
		expect(await refused([''])).toBe(on('that is an array'));
		expect(await refused([[]])).toBe(on('that is an array'));
	});

	test('a key beside filter, which the SDK’s rule does not have', async () => {
		expect(await refused({ filter: 'genres = scifi', note: 'x' })).toBe(
			on('that has a key other than filter'),
		);
	});

	test('a string or a number given as a rule', async () => {
		expect(await refused('genres = scifi')).toBe(on('that is a string'));
		expect(await refused(1)).toBe(on('that is a number'));
	});
	test('a filter that is an object or a boolean, or holds undefined or null', async () => {
		expect(await refused({ filter: { genres: 'scifi' } })).toBe(
			on('whose filter is an object'),
		);
		expect(await refused({ filter: true })).toBe(
			on('whose filter is a boolean'),
		);
		expect(await refused({ filter: ['genres = scifi', undefined] })).toBe(
			on('whose filter holds undefined'),
		);
		expect(await refused({ filter: [['genres = scifi', null]] })).toBe(
			on('whose filter holds null'),
		);
	});
});
