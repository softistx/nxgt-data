import type { Embedders, FacetOrder, ProximityPrecision } from 'meilisearch';
import type { AttributePattern, DocumentPath } from './paths';
import { INDEX_UID_SHAPE, isIndexUid } from './uid';

/**
 * The keys of a document that can be its primary key: those whose value is a
 * string or a number, the two types Meilisearch accepts as a document id.
 */
export type PrimaryKeyOf<Doc> = {
	[K in keyof Doc & string]-?: NonNullable<Doc[K]> extends string | number
		? K
		: never;
}[keyof Doc & string];

/** A ranking rule: a built-in one, or a custom `attribute:asc|desc`. */
export type RankingRule<Path extends string> =
	| 'words'
	| 'typo'
	| 'proximity'
	| 'attribute'
	| 'attributeRank'
	| 'wordPosition'
	| 'sort'
	| 'exactness'
	| `${Path}:asc`
	| `${Path}:desc`;

/** A `filterableAttributes` entry that turns single features on or off. */
export interface GranularFilterableAttribute<Path extends string> {
	attributePatterns: readonly (Path | AttributePattern)[];
	features: {
		facetSearch: boolean;
		filter: { equality: boolean; comparison: boolean };
	};
}

/** A `localizedAttributes` entry: which attributes are in which languages. */
export interface LocalizedAttribute<Path extends string> {
	attributePatterns: readonly (Path | AttributePattern)[];
	/** ISO 639-3 codes, such as `fra` or `eng`. */
	locales: readonly string[];
}

/**
 * The settings of an index, typed by its document: every attribute list only
 * takes the document's attributes. Each is optional, and one left out is not
 * managed: `sync` leaves it as it is on the server.
 */
export interface IndexSettings<Doc> {
	/** In order of importance. `['*']`, the default, searches every attribute. */
	searchableAttributes?: readonly (DocumentPath<Doc> | '*')[];
	filterableAttributes?: readonly (
		| DocumentPath<Doc>
		| GranularFilterableAttribute<DocumentPath<Doc>>
	)[];
	sortableAttributes?: readonly DocumentPath<Doc>[];
	/** `['*']`, the default, displays every attribute. */
	displayedAttributes?: readonly (DocumentPath<Doc> | '*')[];
	distinctAttribute?: DocumentPath<Doc> | null;
	rankingRules?: readonly RankingRule<DocumentPath<Doc>>[];
	synonyms?: Readonly<Record<string, readonly string[]>>;
	stopWords?: readonly string[];
	typoTolerance?: {
		enabled?: boolean;
		disableOnAttributes?: readonly DocumentPath<Doc>[];
		disableOnWords?: readonly string[];
		disableOnNumbers?: boolean;
		minWordSizeForTypos?: { oneTypo?: number; twoTypos?: number };
	};
	faceting?: {
		maxValuesPerFacet?: number;
		sortFacetValuesBy?: Readonly<
			Partial<Record<DocumentPath<Doc> | '*', FacetOrder>>
		>;
	};
	pagination?: { maxTotalHits?: number };
	separatorTokens?: readonly string[];
	nonSeparatorTokens?: readonly string[];
	dictionary?: readonly string[];
	proximityPrecision?: ProximityPrecision;
	searchCutoffMs?: number | null;
	localizedAttributes?: readonly LocalizedAttribute<DocumentPath<Doc>>[] | null;
	facetSearch?: boolean;
	prefixSearch?: 'indexingTime' | 'disabled';
	/** The SDK's own type: an embedder's fields do not depend on the document. */
	embedders?: Embedders;
}

/** What `defineIndex<Doc>()` takes. */
export interface IndexConfig<Doc> {
	/**
	 * The index's uid on the server: 1 to 400 characters, each an ASCII
	 * letter, a digit, `-` or `_`. Anything else throws a `TypeError`. Keep it
	 * to 395 to `rebuild` under the default `<uid>_next`.
	 */
	uid: string;
	/** The attribute that identifies a document; it types every id. */
	primaryKey: PrimaryKeyOf<Doc>;
	settings?: IndexSettings<Doc>;
}

declare const documentType: unique symbol;

/**
 * An index, as `defineIndex` returns it: its config, with the literal types
 * of every setting kept, and the document type it indexes.
 */
export type IndexDefinition<
	Doc extends object,
	Config extends IndexConfig<Doc> = IndexConfig<Doc>,
> = Readonly<Config> & {
	/** Never set: only carries the document type. */
	readonly [documentType]?: Doc;
};

/** Any definition, whatever its document. */
export type AnyIndexDefinition = IndexDefinition<any, IndexConfig<any>>;

/** The document type of a definition. */
export type DocumentOf<Def> = Def extends {
	readonly [documentType]?: infer Doc;
}
	? Exclude<Doc, undefined>
	: never;

/** The primary key of a definition, as a literal. */
export type PrimaryKeyNameOf<Def> = Def extends { primaryKey: infer K }
	? K & keyof DocumentOf<Def> & string
	: never;

/** The type of a document id: the type of the primary key's attribute. */
export type IdOf<Def> = NonNullable<DocumentOf<Def>[PrimaryKeyNameOf<Def>]>;

// No settings for a definition without them: `never` here would let the
// `infer` below widen every attribute list to `string`.
type SettingsOf<Def> = Def extends { readonly settings: infer S }
	? S
	: Record<never, never>;

/** The attributes a definition makes sortable. */
export type SortableOf<Def> =
	SettingsOf<Def> extends {
		sortableAttributes: readonly (infer A)[];
	}
		? A & string
		: never;

/**
 * The attributes a definition makes filterable, by name or inside a granular
 * entry. Wildcard patterns are left out: they name no attribute.
 */
export type FilterableOf<Def> =
	SettingsOf<Def> extends {
		filterableAttributes: readonly (infer A)[];
	}
		? A extends string
			? A
			: A extends { attributePatterns: readonly (infer P)[] }
				? Exclude<P & string, AttributePattern>
				: never
		: never;

/**
 * The attributes a search can be restricted to: the definition's
 * `searchableAttributes`, or every attribute when it names none, or `*`.
 */
export type SearchableOf<Def> =
	SettingsOf<Def> extends {
		searchableAttributes: readonly (infer A)[];
	}
		? '*' extends A
			? DocumentPath<DocumentOf<Def>>
			: A & string
		: DocumentPath<DocumentOf<Def>>;

/** Keys a definition may not have, reported as `never` so they fail. */
type NoExtraKeys<Given, Allowed> = {
	[K in Exclude<keyof Given, keyof Allowed>]: never;
};

/**
 * What the types allow a uid to be, looked up by the uid itself: `never` for
 * a literal that is empty or holds a space, a `*`, a dot or a slash — the
 * mistakes a uid is most likely to be given — and `unknown` for anything
 * else. Only a cheap denylist: a unicode lookalike or a 401st character
 * compiles, and is refused at run time.
 *
 * A lookup, not a conditional type, on purpose: a conditional on a generic
 * uid (`<U extends string>(uid: U) => defineIndex…({ uid })`) stays deferred
 * and refuses it. An indexed access on a type parameter is let through, as a
 * `string` is, and a union of literals reads `unknown` as soon as one member
 * is valid: those are checked at run time only.
 */
interface UidAllowed {
	[uid: string]: unknown;
	[uid: `${string}*${string}`]: never;
	[uid: `${string} ${string}`]: never;
	[uid: `${string}.${string}`]: never;
	[uid: `${string}/${string}`]: never;
	'': never;
}

/**
 * Defines an index: its uid, its primary key and its settings, typed by the
 * document it holds.
 *
 * It is curried, `defineIndex<Movie>()({ … })`, because TypeScript infers
 * all of a call's type arguments or none: given `Movie`, it would no longer
 * infer the settings, and their literal types, which type the searches and
 * sorts of the index, would widen to `string`.
 *
 * A uid Meilisearch would refuse — empty, over 400 characters, or holding
 * anything but ASCII letters, digits, `-` and `_` — throws a `TypeError`
 * here, before any request: a `*` in it would otherwise widen a tenant token
 * to other indexes. The message names no uid.
 *
 * ```ts
 * export const movies = defineIndex<Movie>()({
 * 	uid: 'movies',
 * 	primaryKey: 'id',
 * 	settings: { sortableAttributes: ['year'] },
 * });
 * ```
 */
export function defineIndex<Doc extends object>() {
	return <const Config extends IndexConfig<Doc>>(
		config: Config &
			NoExtraKeys<Config, IndexConfig<Doc>> & {
				uid: UidAllowed[Config['uid']];
			} & {
				settings?: NoExtraKeys<
					NonNullable<Config['settings']>,
					IndexSettings<Doc>
				>;
			},
	): IndexDefinition<Doc, Config> => {
		// The message names no uid: one built from a request stays out of logs.
		if (!isIndexUid(config.uid)) {
			throw new TypeError(`defineIndex: the uid must be ${INDEX_UID_SHAPE}`);
		}
		return Object.freeze({ ...config }) as IndexDefinition<Doc, Config>;
	};
}
