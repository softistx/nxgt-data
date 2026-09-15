/** What a path stops at: a value with no attributes of its own. */
type Leaf =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| Date
	| ((...args: any[]) => unknown);

/** One less depth, down to `never`. */
type Previous = [never, 0, 1, 2, 3];

/** An array's element, or the value itself: Meilisearch flattens arrays. */
type Element<T> = T extends readonly (infer E)[] ? E : T;

type Nested<K extends string, V, Depth extends number> = V extends Leaf
	? never
	: V extends object
		? `${K}.${DocumentPath<V, Previous[Depth]>}`
		: never;

/**
 * Every attribute of a document, as Meilisearch names it: its keys, and the
 * dot paths into its nested objects, arrays of objects included
 * (`author.name`, `reviews.score`), to four levels.
 */
export type DocumentPath<T, Depth extends number = 3> = [Depth] extends [never]
	? never
	: {
			[K in keyof T & string]-?:
				| K
				| Nested<K, NonNullable<Element<NonNullable<T[K]>>>, Depth>;
		}[keyof T & string];

/**
 * A pattern with a wildcard, `meta.*` or `*_at`, as `filterableAttributes`
 * and `localizedAttributes` accept one. It is not checked against the
 * document.
 */
export type AttributePattern = `${string}*${string}`;
