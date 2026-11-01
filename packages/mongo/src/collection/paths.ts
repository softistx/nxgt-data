import type { DocumentOf } from '../definition/define-collection';

/** Values a path stops at: they hold no fields of their own to follow. */
type Leaf =
	| Date
	| { readonly _bsontype: string }
	| readonly unknown[]
	| ((...args: never[]) => unknown);

/**
 * Every dotted path into `Doc`, through plain nested objects only, to a depth
 * of five: `'quantity' | 'quantity.baseQuantity'`. Dates, ObjectIds and arrays
 * are leaves; a path never goes through an array.
 */
type PathsOf<
	Doc,
	Depth extends readonly unknown[] = [],
> = Depth['length'] extends 5
	? never
	: {
			[K in keyof Doc & string]:
				| K
				| (NonNullable<Doc[K]> extends Leaf
						? never
						: NonNullable<Doc[K]> extends object
							? `${K}.${PathsOf<NonNullable<Doc[K]>, [...Depth, unknown]>}`
							: never);
		}[keyof Doc & string];

/**
 * A field of the documents, or a dotted path into a nested object
 * (`'quantity.baseQuantity'`). Unlike `FieldPath`, the whole path is checked
 * against the document type.
 */
export type OrderPathOf<Def> = PathsOf<DocumentOf<Def>>;
