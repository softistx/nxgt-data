import type {
	DocumentOf,
	FieldOf,
	IdOf,
	ReadDocumentOf,
} from '../../definition/define-collection';
import type { FilterOf, ReadOptions } from '../types';

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

/** The fields whose values are numbers, which a sum or an average can take. */
export type NumericFieldOf<Def> = {
	[K in FieldOf<Def>]: NonNullable<DocumentOf<Def>[K]> extends number
		? K
		: never;
}[FieldOf<Def>];

/**
 * One figure `groupBy` computes per group, next to its `count`: exactly one
 * of `sum`, `avg`, `min` or `max` — the others are `never`, which a union
 * would otherwise let through together.
 */
export type Measure<Def> =
	| { readonly sum: NumericFieldOf<Def>; avg?: never; min?: never; max?: never }
	| { readonly avg: NumericFieldOf<Def>; sum?: never; min?: never; max?: never }
	| { readonly min: FieldOf<Def>; sum?: never; avg?: never; max?: never }
	| { readonly max: FieldOf<Def>; sum?: never; avg?: never; min?: never };

export type Measures<Def> = Record<string, Measure<Def>>;

/**
 * The names a measure cannot take: the group's own `key` and `count`, the
 * server's `_id` — which would replace what the documents are grouped on —
 * an operator, or a path.
 */
type ReservedName =
	| 'key'
	| 'count'
	| '_id'
	| `$${string}`
	| `${string}.${string}`;

/** The measures as given, a reserved name refused. */
export type NamedMeasures<M> = {
	[N in keyof M]: N extends ReservedName ? never : M[N];
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
	filter?: FilterOf<Def>;
	measures?: M & NamedMeasures<M>;
	/** `'count'` (default): the largest groups first. `'key'`: by key. */
	sort?: 'count' | 'key';
	limit?: number;
}

/** A collection, as far as `populate` needs one: typed, and able to read. */
export interface RelatedCollection<F> {
	readonly definition: F;
	findMany(options: {
		filter: FilterOf<F>;
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

/**
 * The documents, each with its related ones under the relation's name. A
 * list field gives a list — `[]` when it is missing — and any other field one
 * document or `null`.
 */
export type Populated<Def, Doc, R> = Doc & {
	[N in keyof R]: RelatedValue<Def, R[N]>;
};
