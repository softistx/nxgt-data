import type {
	TenantTokenGeneratorOptions,
	TokenIndexRules,
	TokenSearchRules,
} from 'meilisearch';
import { generateTenantToken } from 'meilisearch/token';
import { SearchIndexError } from '../errors/search-index-error';
import type { TypedIndex } from '../index/bind-index';

/** The uid a bound index's definition gives, as a literal. */
type UidOf<Index> = Index extends {
	definition: { uid: infer Uid extends string };
}
	? Uid
	: never;

/** At least one bound index: a token for none can search nothing. */
export type TokenIndexes = readonly [TypedIndex<any>, ...TypedIndex<any>[]];

/**
 * The rules of a token, keyed by the uids of its indexes and by nothing
 * else. `filter` is added to every search on that index; a missing rule, or
 * `null`, lets the index be searched with no filter.
 */
export type TenantTokenRules<Indexes extends TokenIndexes> = {
	readonly [Uid in UidOf<Indexes[number]>]?: TokenIndexRules | null;
};

export interface TenantTokenOptions<Indexes extends TokenIndexes> {
	/** The key that signs the token. It must hold `search` on these indexes. */
	apiKey: string;
	/** That key's `uid`, a UUID v4. */
	apiKeyUid: string;
	/** The indexes the token may search; every other one is refused. */
	indexes: Indexes;
	searchRules?: TenantTokenRules<Indexes>;
	/**
	 * When the token stops working: a `Date`, or a whole number of **seconds**
	 * since the epoch. Refused when it is already past, or when it is a number
	 * of milliseconds. Without it, the token lasts as long as its key.
	 */
	expiresAt?: Date | number;
	/** The SDK's: `HS256` by default. */
	algorithm?: TenantTokenGeneratorOptions['algorithm'];
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
 * 	searchRules: { movies: { filter: `studio = ${JSON.stringify(studio)}` } },
 * 	expiresAt: new Date(Date.now() + 60 * 60 * 1000),
 * });
 * ```
 *
 * An `expiresAt` that is past, or not a time Meilisearch reads, throws a
 * `SearchIndexError` (`INVALID_EXPIRES_AT`) before anything is signed.
 */
export async function tenantToken<const Indexes extends TokenIndexes>(
	options: TenantTokenOptions<Indexes>,
): Promise<string> {
	const { apiKey, apiKeyUid, indexes, expiresAt, algorithm } = options;
	const uids = indexes.map((index) => index.uid);
	if (expiresAt !== undefined) {
		const problem = expiryProblem(expiresAt, Date.now());
		if (problem) {
			const on = uids.map((uid) => `"${uid}"`).join(', ');
			throw new SearchIndexError(
				`tenantToken for ${on}: expiresAt ${problem}`,
				{ code: 'INVALID_EXPIRES_AT', indexUid: uids.join(',') },
			);
		}
	}
	const rules = (options.searchRules ?? {}) as Record<
		string,
		TokenIndexRules | null | undefined
	>;
	const searchRules: TokenSearchRules = Object.fromEntries(
		uids.map((uid) => [uid, rules[uid] ?? null]),
	);
	return generateTenantToken({
		apiKey,
		apiKeyUid,
		searchRules,
		...(expiresAt === undefined ? {} : { expiresAt }),
		...(algorithm === undefined ? {} : { algorithm }),
	});
}
