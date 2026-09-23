// Type tests for `tenantToken`, checked by `tsc --noEmit` and never run.

import type { Meilisearch } from 'meilisearch';
import { bindIndex, defineIndex, tenantToken } from '../../src';
import { movies } from '../movies';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const client: Meilisearch;
declare const apiKey: string;
declare const apiKeyUid: string;

const people = defineIndex<{ slug: string; country: string }>()({
	uid: 'people',
	primaryKey: 'slug',
});
const movieIndex = bindIndex(client, movies);
const peopleIndex = bindIndex(client, people);

// The rules are keyed by the uids of the indexes given.
const token = await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex, peopleIndex],
	searchRules: {
		movies: { filter: 'genres = scifi' },
		people: { filter: ['country = UK', 'country = FR'] },
	},
	expiresAt: new Date(Date.now() + 3_600_000),
});
assertType<Equal<typeof token, string>>(true);

// A rule may be left out, or null: that index is searched with no filter.
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex, peopleIndex],
	searchRules: { people: null },
	expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error people is not one of the token's indexes
	searchRules: { people: { filter: 'country = UK' } },
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error a misspelt uid
	searchRules: { movie: { filter: 'genres = scifi' } },
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error a filter is a string or an array, not an object
	searchRules: { movies: { filter: { genres: 'scifi' } } },
});
await tenantToken({
	apiKey,
	apiKeyUid,
	// @ts-expect-error a token for no index searches nothing
	indexes: [],
});
await tenantToken({
	apiKey,
	apiKeyUid,
	// @ts-expect-error a bound index, not a uid
	indexes: ['movies'],
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error a Date or a number of seconds, not a string
	expiresAt: '2030-01-01',
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error Meilisearch signs with HS256, HS384 or HS512
	algorithm: 'RS256',
});
// @ts-expect-error the key is required
await tenantToken({ apiKeyUid, indexes: [movieIndex] });

// A rebuild's next index has a uid that is only a string: its rules cannot
// be checked by the types, and a wrong key is refused at run time instead.
await bindIndex(client, movies).rebuild(async (next) => {
	await tenantToken({
		apiKey,
		apiKeyUid,
		indexes: [next],
		searchRules: { movies_next: { filter: 'genres = scifi' } },
	});
});
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], force: true });
// @ts-expect-error force is a boolean
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], force: 'yes' });
