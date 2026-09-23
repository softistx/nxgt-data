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
const expiresAt = new Date(Date.now() + 3_600_000);

// The rules are keyed by the uids of the indexes given, one per index.
const token = await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex, peopleIndex],
	searchRules: {
		movies: { filter: 'genres = scifi' },
		people: { filter: ['country = UK', 'country = FR'] },
	},
	expiresAt,
});
assertType<Equal<typeof token, string>>(true);

// An explicit null searches that index with no filter.
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex, peopleIndex],
	searchRules: { movies: { filter: 'genres = scifi' }, people: null },
	expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex, peopleIndex],
	// @ts-expect-error people has no rule: a missing rule is not a null one
	searchRules: { movies: { filter: 'genres = scifi' } },
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error undefined is not a rule; null is
	searchRules: { movies: undefined },
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error a rule object needs its filter; no filter is null
	searchRules: { movies: {} },
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error an undefined filter is no filter
	searchRules: { movies: { filter: undefined } },
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error a null filter is no filter
	searchRules: { movies: { filter: null } },
	expiresAt,
});
// An empty filter compiles, since the SDK's Filter is any string or array:
// it is refused at run time.
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: { filter: '' } },
	expiresAt,
});
// @ts-expect-error searchRules is required
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], expiresAt });
// @ts-expect-error expiresAt is required: without it a token lasts as long as its key
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: null },
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: null },
	// @ts-expect-error expiresAt is required, not undefined
	expiresAt: undefined,
});

await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error people is not one of the token's indexes
	searchRules: { movies: null, people: { filter: 'country = UK' } },
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error a misspelt uid
	searchRules: { movie: { filter: 'genres = scifi' } },
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	// @ts-expect-error a filter is a string or an array, not an object
	searchRules: { movies: { filter: { genres: 'scifi' } } },
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	// @ts-expect-error a token for no index searches nothing
	indexes: [],
	searchRules: {},
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	// @ts-expect-error a bound index, not a uid
	indexes: ['movies'],
	searchRules: {},
	expiresAt,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: null },
	// @ts-expect-error a Date or a number of seconds, not a string
	expiresAt: '2030-01-01',
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: null },
	expiresAt,
	// @ts-expect-error Meilisearch signs with HS256, HS384 or HS512
	algorithm: 'RS256',
});
// @ts-expect-error the key is required
await tenantToken({
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: null },
	expiresAt,
});

// A rebuild's next index has a uid that is only a string: its rule is keyed
// by that runtime uid, and neither a missing nor a wrong key can be seen by
// the types — both are refused at run time instead.
await bindIndex(client, movies).rebuild(async (next) => {
	await tenantToken({
		apiKey,
		apiKeyUid,
		indexes: [next],
		searchRules: { [next.uid]: { filter: 'genres = scifi' } },
		expiresAt,
	});
	await tenantToken({
		apiKey,
		apiKeyUid,
		indexes: [next],
		searchRules: { [next.uid]: null },
		expiresAt,
	});
	// With a literal uid beside it, that one's rule is still required.
	await tenantToken({
		apiKey,
		apiKeyUid,
		indexes: [next, peopleIndex],
		searchRules: { [next.uid]: null, people: { filter: 'country = UK' } },
		expiresAt,
	});
	await tenantToken({
		apiKey,
		apiKeyUid,
		indexes: [next, peopleIndex],
		// @ts-expect-error people has no rule
		searchRules: { [next.uid]: null },
		expiresAt,
	});
	await tenantToken({
		apiKey,
		apiKeyUid,
		indexes: [next],
		// @ts-expect-error a rule is an object or null, even under a dynamic uid
		searchRules: { [next.uid]: 'genres = scifi' },
		expiresAt,
	});
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: null },
	expiresAt,
	force: true,
});
await tenantToken({
	apiKey,
	apiKeyUid,
	indexes: [movieIndex],
	searchRules: { movies: null },
	expiresAt,
	// @ts-expect-error force is a boolean
	force: 'yes',
});
