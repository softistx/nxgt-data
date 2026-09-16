import type { Filter } from 'mongodb';
import type {
	DocumentOf,
	FieldOf,
	IdOf,
	ReadDocumentOf,
} from '../../definition/define-collection';
import type { ReadOptions } from '../types';

/** An array's element, or the value itself. */
type ElementOf<T> = T extends readonly (infer E)[] ? E : T;

/**
 * What `distinct` answers for a field: an array field's elements, since the
 * server unwinds it, and never `undefined` — a missing field is no value.
 */
export type DistinctOf<Def, K extends FieldOf<Def>> = Exclude<
	ElementOf<DocumentOf<Def>[K]>,
	undefined
>;

export interface DistinctOptions<Def> extends ReadOptions {
	filter?: Filter<DocumentOf<Def>>;
}

/** The fields whose values are numbers, which a sum or an average can take. */
export type NumericFieldOf<Def> = {
	[K in FieldOf<Def>]: NonNullable<DocumentOf<Def>[K]> extends number
		? K
		: never;
}[FieldOf<Def>];

/** One figure `groupBy` computes per group, next to its `count`. */
export type Measure<Def> =
	| { readonly sum: NumericFieldOf<Def> }
	| { readonly avg: NumericFieldOf<Def> }
	| { readonly min: FieldOf<Def> }
	| { readonly max: FieldOf<Def> };

/** The names `groupBy` gives its measures. `key` and `count` are its own. */
export type Measures<Def> = Record<string, Measure<Def>> & {
	key?: never;
	count?: never;
};

type Present<T> = Exclude<T, undefined>;

type MeasureValue<Def, M> = M extends { sum: unknown }
	? // A group where the field is missing everywhere sums to 0.
		number
	: M extends { avg: unknown }
		? // …and has no average.
			number | null
		: M extends { min: infer K extends FieldOf<Def> }
			? Present<DocumentOf<Def>[K]> | null
			: M extends { max: infer K extends FieldOf<Def> }
				? Present<DocumentOf<Def>[K]> | null
				: never;

/**
 * The value a group is keyed on. Documents that lack the field are one
 * group, keyed `null`, as the server groups them.
 */
export type GroupKeyOf<Def, K extends FieldOf<Def>> =
	| Present<DocumentOf<Def>[K]>
	| (undefined extends DocumentOf<Def>[K] ? null : never);

export type Group<Def, K extends FieldOf<Def>, M> = {
	key: GroupKeyOf<Def, K>;
	count: number;
} & { [N in keyof M]: MeasureValue<Def, M[N]> };

export interface GroupByOptions<Def, M> extends ReadOptions {
	filter?: Filter<DocumentOf<Def>>;
	measures?: M;
	/** `'count'` (default): the largest groups first. `'key'`: by key. */
	sort?: 'count' | 'key';
	limit?: number;
}

/** A collection, as far as `populate` needs one: typed, and able to read. */
export interface RelatedCollection<F> {
	readonly definition: F;
	findMany(options: {
		filter: Filter<DocumentOf<F>>;
		sort: { _id: 1 };
		withDeleted?: boolean;
	}): Promise<ReadDocumentOf<F>[]>;
}

/** The fields of `Def` that hold an id of `Target`, or a list of them. */
export type ReferenceFieldOf<Def, Target> = {
	[K in FieldOf<Def>]: [NonNullable<ElementOf<DocumentOf<Def>[K]>>] extends [
		IdOf<Target>,
	]
		? K
		: never;
}[FieldOf<Def>];

/** The documents a field of these ones points to: `{ by: 'authorId' }`. */
export interface ByRelation<Def, F> {
	readonly from: RelatedCollection<F>;
	readonly by: ReferenceFieldOf<Def, F>;
	readonly on?: never;
	readonly withDeleted?: boolean;
}

/** The documents that point to these ones: `{ on: 'teamId' }`. */
export interface OnRelation<Def, F> {
	readonly from: RelatedCollection<F>;
	readonly on: ReferenceFieldOf<F, Def>;
	readonly by?: never;
	readonly withDeleted?: boolean;
}

type AnyRelation = {
	from: { definition: unknown };
	by?: unknown;
	on?: unknown;
};

/**
 * The relations as given, each checked against the collection it reads
 * from. A name the documents already use is refused: it would be overwritten.
 */
export type Relations<Def, R> = {
	[N in keyof R]: N extends keyof DocumentOf<Def> | 'id'
		? never
		: R[N] extends { from: { definition: infer F } }
			? R[N] extends { on: unknown }
				? OnRelation<Def, F>
				: ByRelation<Def, F>
			: never;
};

type RelatedValue<Def, Rel> = Rel extends {
	from: { definition: infer F };
	by: infer K extends FieldOf<Def>;
}
	? NonNullable<DocumentOf<Def>[K]> extends readonly unknown[]
		? ReadDocumentOf<F>[]
		: ReadDocumentOf<F> | null
	: Rel extends { from: { definition: infer F }; on: unknown }
		? ReadDocumentOf<F>[]
		: never;

/** The documents, each with its related ones under the relation's name. */
export type Populated<Def, Doc, R> = Doc & {
	[N in keyof R]: RelatedValue<Def, R[N]>;
};

export type { AnyRelation };
