import type { TenantTokenGeneratorOptions, TokenIndexRules } from 'meilisearch';
import { generateTenantToken } from 'meilisearch/token';
import { SearchIndexError } from '../errors/search-index-error';
import type { TypedIndex } from '../index/bind-index';
import { copyRules } from './rules';

/** Every uid an index's definition may have: a union when the index is. */
type UidsOf<Index> = Index extends {
	definition: { uid: infer Uid extends string };
}
	? Uid
	: never;

/** Whether `T` is a union of more than one member. */
type IsUnion<T, All = T> = T extends unknown
	? [All] extends [T]
		? false
		: true
	: never;

/**
 * Whether the types cannot tell which one uid an index has: typed `string`
 * (a rebuild's next index), or a union of literals (`cond ? a : b`).
 */
type IsLoose<Index> =
	string extends UidsOf<Index>
		? true
		: true extends IsUnion<UidsOf<Index>>
			? true
			: false;

/** The uids the types can require a rule for: one literal per index. */
type FixedUids<Indexes extends TokenIndexes> = {
	[K in keyof Indexes]: IsLoose<Indexes[K]> extends true
		? never
		: UidsOf<Indexes[K]>;
}[number];

/** Whether one of the indexes has a uid the types cannot pin down. */
type HasLooseUid<Indexes extends TokenIndexes> = true extends {
	[K in keyof Indexes]: IsLoose<Indexes[K]>;
}[number]
	? true
	: false;

/** At least one bound index: a token for none can search nothing. */
export type TokenIndexes = readonly [TypedIndex<any>, ...TypedIndex<any>[]];

/**
 * One index's rule: `filter` is added to every search on it, and `null`
 * searches it with no filter — which has to be said, never left out. A rule
 * object must carry its `filter`: the SDK's is optional, and a rule without
 * one signs an unfiltered token. An empty filter (`''`, `[]`) compiles and is
 * refused at run time.
 */
export type TenantTokenRule =
	| (Omit<TokenIndexRules, 'filter'> & {
			filter: NonNullable<TokenIndexRules['filter']>;
	  })
	| null;

/**
 * The rules of a token: one per index, keyed by its uid, and nothing else. A
 * rule left out does not compile for an index whose uid is one literal. For
 * one whose uid is only a `string` — a rebuild's next index — or a union of
 * literals — `cond ? movieIndex : peopleIndex` — any key compiles, and a
 * missing or unmatched rule is refused at run time.
 */
export type TenantTokenRules<Indexes extends TokenIndexes> = {
	readonly [Uid in FixedUids<Indexes>]: TenantTokenRule;
} & (HasLooseUid<Indexes> extends true
	? { readonly [uid: string]: TenantTokenRule }
	: unknown);

export interface TenantTokenOptions<Indexes extends TokenIndexes> {
	/** The key that signs the token. It must hold `search` on these indexes. */
	apiKey: string;
	/** That key's `uid`, a UUID v4. */
	apiKeyUid: string;
	/** The indexes the token may search; every other one is refused. */
	indexes: Indexes;
	/**
	 * A rule for every index given, keyed by its uid: `{ filter }`, or `null`
	 * to search that index with no filter. A missing rule is refused.
	 */
	searchRules: TenantTokenRules<Indexes>;
	/**
	 * When the token stops working: a `Date`, or a whole number of **seconds**
	 * since the epoch. Required: a token without one would last as long as
	 * its key. Refused when it is already past, or when it is a number of
	 * milliseconds.
	 */
	expiresAt: Date | number;
	/** The SDK's: `HS256` by default. */
	algorithm?: TenantTokenGeneratorOptions['algorithm'];
	/**
	 * The SDK's: skip its check that it runs on a server (Node, Bun, Deno,
	 * Cloudflare Workers), which otherwise throws. `false` by default.
	 */
	force?: boolean;
}

// A time in seconds past this is a time in milliseconds: 10^11 seconds is
// the year 5138, and `Date.now()` has been past 10^12 since 2001.
const MAX_SECONDS = 1e11;

/** Why `expiresAt` cannot be signed, or `undefined` when it can. */
function expiryProblem(expiresAt: Date | number, now: number) {
	if (expiresAt instanceof Date) {
		const time = expiresAt.getTime();
		if (Number.isNaN(time)) return 'is an invalid Date';
		return time <= now ? 'is in the past' : undefined;
	}
	if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
		return 'is neither a Date nor a finite number';
	}
	// Measured on v1.53.2: a fractional `exp` makes every search with the
	// token fail to decode it, and one in milliseconds is accepted, and lasts
	// for millennia.
	if (!Number.isInteger(expiresAt)) return 'is not a whole number of seconds';
	if (expiresAt > MAX_SECONDS) {
		return 'is a number of milliseconds; it takes seconds, or a Date';
	}
	return expiresAt * 1000 <= now ? 'is in the past' : undefined;
}

const quoted = (uids: readonly string[]) =>
	uids.map((uid) => `"${uid}"`).join(', ');

/** Refuses an `expiresAt` that is missing, or cannot be signed. */
function checkExpiry(expiresAt: unknown, uids: readonly string[]) {
	const problem =
		expiresAt === undefined || expiresAt === null
			? 'is missing; it takes a Date, or whole seconds since the epoch'
			: expiryProblem(expiresAt as Date | number, Date.now());
	if (problem) {
		throw new SearchIndexError(
			`tenantToken for ${quoted(uids)}: expiresAt ${problem}`,
			{ code: 'INVALID_EXPIRES_AT', indexUid: uids.join(',') },
		);
	}
}

/**
 * Signs a tenant token that may search only the indexes given, each with
 * its own rule, with the SDK's `generateTenantToken`. Nothing is sent: the
 * token is checked by Meilisearch when a client made from it searches.
 *
 * ```ts
 * const token = await tenantToken({
 * 	apiKey: searchKey.key,
 * 	apiKeyUid: searchKey.uid,
 * 	indexes: [movieIndex],
 * 	searchRules: { movies: { filter: `genres = ${JSON.stringify(genre)}` } },
 * 	expiresAt: new Date(Date.now() + 60 * 60 * 1000),
 * });
 * ```
 *
 * It fails closed. An `expiresAt` that is missing, past, or not a time
 * Meilisearch reads throws a `SearchIndexError` (`INVALID_EXPIRES_AT`). A
 * `TypeError` is thrown for a `searchRules` that is not a plain object, a
 * rule under a uid none of `indexes` has, an index with no rule, a rule that
 * is not `null` or a plain `{ filter }` — an array, a class instance, a
 * getter, a `toJSON`, another key, a filter that is inherited, hidden or not
 * a string or an array of strings — and an empty rule, whose filter is
 * absent, blank or only blanks. Each rule is read once, into a plain copy,
 * and that copy is what is checked and signed. Both are thrown before
 * anything is signed.
 */
export async function tenantToken<const Indexes extends TokenIndexes>(
	options: TenantTokenOptions<Indexes>,
): Promise<string> {
	const { apiKey, apiKeyUid, indexes, expiresAt, algorithm, force } = options;
	// An index given twice is one uid: the messages name it once.
	const uids = [...new Set(indexes.map((index) => index.uid))];
	checkExpiry(expiresAt, uids);
	const call = `tenantToken for ${quoted(uids)}`;
	const searchRules = copyRules(options.searchRules, uids, call);
	return generateTenantToken({
		apiKey,
		apiKeyUid,
		searchRules,
		expiresAt,
		...(algorithm === undefined ? {} : { algorithm }),
		...(force === undefined ? {} : { force }),
	});
}
