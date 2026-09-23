import type { TenantTokenGeneratorOptions, TokenIndexRules } from 'meilisearch';
import { generateTenantToken } from 'meilisearch/token';
import { isIndexUid } from '../definition/uid';
import type { TypedIndex } from '../index/bind-index';
import { expirySeconds } from './expiry';
import { copyRules, quoted } from './rules';

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
	 * its key. Refused when it is already past, a number of milliseconds, or a
	 * `Date` past the year 5138. A `Date` is read once, with the intrinsic
	 * `Date.prototype.getTime`, and the whole seconds are what is signed.
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

/**
 * Refuses a uid that is not an index uid. Meilisearch reads a token's rule
 * keys as index **patterns**: measured on v1.53.2, a uid of `*` with a `null`
 * rule signed a token that searched every other index. A uid built from a
 * request — `docs_${tenant}` — can hold one. The message names no uid.
 *
 * `defineIndex` and `bindIndex` refuse such a uid first, with the same
 * function; this one still fires for an index that did not come from
 * `bindIndex`, or whose `uid` was reassigned after it.
 */
function checkUids(uids: readonly string[]) {
	if (uids.every(isIndexUid)) {
		return;
	}
	throw new TypeError(
		'tenantToken: an index uid is not a valid Meilisearch uid ' +
			'(letters, digits, - and _ only), and a * in it would widen the token ' +
			'to other indexes',
	);
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
 * It fails closed. An index whose uid is not a Meilisearch index uid —
 * letters, digits, `-` and `_` — throws a `TypeError`: a `*` would be read
 * as a pattern, widening the token to other indexes. An `expiresAt` that is missing, past, not a real `Date`
 * or a finite number, or not a time Meilisearch reads throws a
 * `SearchIndexError` (`INVALID_EXPIRES_AT`); it is read once, into the whole
 * seconds that are signed. A
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
	checkUids(uids);
	const call = `tenantToken for ${quoted(uids)}`;
	// The seconds, never the caller's object: the SDK would read it again.
	const seconds = expirySeconds(expiresAt, uids, call);
	const searchRules = copyRules(options.searchRules, uids, call);
	return generateTenantToken({
		apiKey,
		apiKeyUid,
		searchRules,
		expiresAt: seconds,
		...(algorithm === undefined ? {} : { algorithm }),
		...(force === undefined ? {} : { force }),
	});
}
