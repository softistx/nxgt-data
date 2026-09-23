import type { z } from 'zod';
import type { StampKind } from './fields';

/** A stamp's literal name, or `never` when it is off or not known. */
type Named<N> = N extends string ? (string extends N ? never : N) : never;

/**
 * The names these stamps have on a definition. A definition typed loosely —
 * its names only `string` — has none here: nothing can be refused by a name
 * that is not known.
 */
export type StampNameOf<Def, K extends StampKind> = Def extends {
	stamps: infer Stamps extends { [P in StampKind]: unknown };
}
	? { [P in K]: Named<Stamps[P]> }[K]
	: never;

/** The version field's name. In an update's patch it is the expected version. */
export type VersionNameOf<Def> = StampNameOf<Def, 'version'>;

/**
 * The stamps only the collection writes: the soft-delete field (`delete`,
 * `restore`), the version (every update), and the actors (`as(actor)`).
 */
export type SetByCollection<Def> = StampNameOf<
	Def,
	'deletedAt' | 'version' | 'createdBy' | 'updatedBy' | 'deletedBy'
>;

/**
 * What an update may not write: those, `createdAt`, which never moves, and
 * `_id`, which MongoDB never changes — `update`, `updateMany` and `upsert`
 * refuse it before anything is sent, so their types leave it out too.
 */
export type FixedOnUpdate<Def> =
	| SetByCollection<Def>
	| StampNameOf<Def, 'createdAt'>
	| '_id';

/**
 * What a create takes: the documents before their defaults are filled, less
 * the stamps the collection writes. `createdAt` and `updatedAt` stay, as
 * optional dates, for a document imported with its own.
 */
export type NewDocumentOf<Def> = Def extends { schema: infer Schema }
	? Schema extends z.ZodType
		? Omit<z.input<Schema>, SetByCollection<Def>> & {
				[K in SetByCollection<Def>]?: never;
			}
		: never
	: never;
