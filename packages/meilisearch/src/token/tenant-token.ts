import type {
	TenantTokenGeneratorOptions,
	TokenIndexRules,
	TokenSearchRules,
} from 'meilisearch';
import { generateTenantToken } from 'meilisearch/token';
import { SearchIndexError } from '../errors/search-index-error';
import type { TypedIndex } from '../index/bind-index';

/**
 * The uid a bound index's definition declares, when it is a literal. A uid
 * typed `string`, such as a rebuild's next index, gives `never`.
 */
type LiteralUidOf<Index> = Index extends {
	definition: { uid: infer Uid extends string };
}
	? string extends Uid
		? never
		: Uid
	: never;

/** Whether one of the indexes has a uid typed only as `string`. */
type HasDynamicUid<Index> = Index extends {
	definition: { uid: infer Uid extends string };
}
	? string extends Uid
		? true
		: never
	: never;

/** At least one bound index: a token for none can search nothing. */
export type TokenIndexes = readonly [TypedIndex<any>, ...TypedIndex<any>[]];

/**
 * One index's rule: `filter` is added to every search on it, and `null`
 * searches it with no filter — which has to be said, never left out.
 */
export type TenantTokenRule = TokenIndexRules | null;

/**
 * The rules of a token: one per index, keyed by its uid, and nothing else. A
 * rule left out does not compile for an index whose uid is a literal; for
 * one whose uid is only a `string` — a rebuild's next index — any key
 * compiles, and a missing or unmatched rule is refused at run time.
 */
export type TenantTokenRules<Indexes extends TokenIndexes> = {
	readonly [Uid in LiteralUidOf<Indexes[number]>]: TenantTokenRule;
} & ([HasDynamicUid<Indexes[number]>] extends [never]
	? unknown
	: { readonly [uid: string]: TenantTokenRule });

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
 * The rules to sign, one per uid, or a `TypeError`: a rule that would be
 * dropped, or an index given none, would leave that index unfiltered.
 */
function checkedRules(given: unknown, uids: readonly string[]) {
	const call = `tenantToken for ${quoted(uids)}`;
	// A rule inherited from a prototype is not an own key: it would be
	// dropped, and its index searched with no filter.
	const prototype =
		given === undefined || given === null
			? Object.prototype
			: Object.getPrototypeOf(given);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${call}: searchRules must be a plain object`);
	}
	const rules = (given ?? {}) as Record<string, TenantTokenRule | undefined>;
	// A rule under a uid no index has would otherwise be dropped: the types
	// cannot see a uid that differs at run time, such as a rebuild's next
	// index.
	const unmatched = Object.keys(rules).filter((uid) => !uids.includes(uid));
	if (unmatched.length > 0) {
		throw new TypeError(
			`${call}: searchRules names ${quoted(unmatched)}, ` +
				'which is not the uid of any of its indexes',
		);
	}
	// An index given no rule, or `undefined`, is refused rather than searched
	// with no filter: that takes an explicit `null`.
	const missing = uids.filter(
		(uid) => !Object.hasOwn(rules, uid) || rules[uid] === undefined,
	);
	if (missing.length > 0) {
		throw new TypeError(
			`${call}: searchRules has no rule for ${quoted([...new Set(missing)])}; ` +
				'give each index { filter: … }, or null to search it with no filter',
		);
	}
	const signed: TokenSearchRules = Object.fromEntries(
		uids.map((uid) => [uid, rules[uid] ?? null]),
	);
	return signed;
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
 * Meilisearch reads throws a `SearchIndexError` (`INVALID_EXPIRES_AT`); an
 * index with no rule in `searchRules`, a rule under a uid none of `indexes`
 * has, or a `searchRules` that is not a plain object throws a `TypeError`.
 * Both are thrown before anything is signed.
 */
export async function tenantToken<const Indexes extends TokenIndexes>(
	options: TenantTokenOptions<Indexes>,
): Promise<string> {
	const { apiKey, apiKeyUid, indexes, expiresAt, algorithm, force } = options;
	const uids = indexes.map((index) => index.uid);
	checkExpiry(expiresAt, uids);
	const searchRules = checkedRules(options.searchRules, uids);
	return generateTenantToken({
		apiKey,
		apiKeyUid,
		searchRules,
		expiresAt,
		...(algorithm === undefined ? {} : { algorithm }),
		...(force === undefined ? {} : { force }),
	});
}
