import type {
	ClientSession,
	Db,
	Collection as DriverCollection,
} from 'mongodb';
import type { z } from 'zod';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import type { StampNames } from '../definition/stamps';
import { NotFoundError } from '../errors/data-error';
import { toDataError } from '../errors/to-data-error';
import { DEFAULT_MAX_PAGE_SIZE } from '../pagination/page';
import { type FieldKinds, kindsOf } from './coerce';
import { type HookSet, hookSetsOf } from './hooks/sets';
import type { CollectionOptions } from './types';

/**
 * What every method of a collection works from, resolved once: the
 * definition, the driver's collection, and the options once they have been
 * read against the schema.
 *
 * It holds **data only**. The operations are plain functions that take it as
 * their first argument, in `filters.ts`, `documents.ts` and the subject
 * folders (`operations/`, `hooks/`, `changes/`) — a context of closures would
 * only be the factory this package split up, one size down.
 *
 * `withSession` and `as` build another one, cheaply: they are the same
 * collection with a single option changed.
 */
export interface CollectionContext {
	readonly definition: AnyCollectionDefinition;
	readonly db: Db;
	/**
	 * The driver's collection, typed loosely on purpose: this layer works on
	 * any documents, and the public type is what callers see.
	 */
	readonly collection: DriverCollection<any>;
	readonly name: string;
	readonly shape: Record<string, z.ZodType>;
	/**
	 * What each stamp is **called** here, or `false` when there is none. Every
	 * write reads its field name from this: nothing below may spell
	 * `'deletedAt'` or `'version'` out, or a renamed stamp would be a lie.
	 */
	readonly stamps: StampNames;
	/** Who is writing, stamped into the actor fields. */
	readonly actor: unknown;
	readonly session: ClientSession | undefined;
	/** `{ session }` when there is one, to spread into the driver's options. */
	readonly sessionOption: { session?: ClientSession };
	readonly maxPageSize: number;
	/**
	 * Whether the schema declares an `id` field of its own. Then `id` is that
	 * field's, and this package neither computes it nor drops it.
	 */
	readonly hasOwnId: boolean;
	/** Whether a write is checked against the schema, which fills its defaults. */
	readonly parses: boolean;
	/**
	 * Whether a string is read as the `ObjectId` or `Date` its field holds.
	 * See `coerce.ts` for what that covers and what it deliberately does not.
	 */
	readonly coerces: boolean;
	/**
	 * Every coercible field, by the path a filter spells — resolved once from
	 * the schema, because walking it per operation would be the same answer
	 * computed again.
	 */
	readonly kinds: FieldKinds;
	/** Whether `delete` writes the soft-delete field rather than removing. */
	readonly softDeletes: boolean;
	/** Whether an update that does not set the updated stamp gets it set. */
	readonly touches: boolean;
	/** Whether an update raises the version field. */
	readonly locks: boolean;
	/**
	 * The hook sets, in the order they run. Functions, but the caller's, and
	 * given as they are: the rule against closures is about the ones this
	 * package would build over the context.
	 */
	readonly hooks: readonly HookSet[];
}

/**
 * Resolves a collection's options against its definition, and refuses the two
 * that cannot be honoured: a soft delete on a collection with no such field,
 * and an optimistic lock with no version field.
 */
export function createContext(
	db: Db,
	definition: AnyCollectionDefinition,
	options: CollectionOptions<never>,
): CollectionContext {
	const name = definition.name;
	const shape = definition.schema.shape as Record<string, z.ZodType>;
	const stamps = definition.stamps;
	const session = options.session;

	if (options.softDelete === true && !stamps.deletedAt) {
		throw new TypeError(
			`getCollection: softDelete needs a soft-delete field, and "${name}" has ` +
				'none. Define it with `softDelete: true`, or a name of your own.',
		);
	}
	if (options.touchUpdatedAt === true && !stamps.updatedAt) {
		throw new TypeError(
			`getCollection: touchUpdatedAt needs an updated stamp, and "${name}" has ` +
				'none. Define it with `timestamps: true`, or a name of your own.',
		);
	}
	if (options.optimisticLock === true && !stamps.version) {
		throw new TypeError(
			`getCollection: optimisticLock needs a version field, and "${name}" has ` +
				'none. Define it with `optimisticLock: true`, or a name of your own.',
		);
	}

	return {
		definition,
		db,
		collection: db.collection<any>(name),
		name,
		shape,
		stamps,
		actor: options.actor as unknown,
		session,
		sessionOption: session ? { session } : {},
		maxPageSize: options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
		hasOwnId: 'id' in shape,
		parses: (options.validate ?? 'parse') === 'parse',
		coerces: options.coerce ?? true,
		kinds: (options.coerce ?? true) ? kindsOf(shape) : {},
		softDeletes: options.softDelete ?? stamps.deletedAt !== false,
		touches: options.touchUpdatedAt ?? stamps.updatedAt !== false,
		locks: options.optimisticLock ?? stamps.version !== false,
		hooks: hookSetsOf(options.hooks),
	};
}

/** Runs an operation, turning a MongoDB error into a `DataError`. */
export async function run<T>(
	ctx: CollectionContext,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toDataError(error, { collection: ctx.name });
	}
}

export function notFound(ctx: CollectionContext, id: unknown): NotFoundError {
	return new NotFoundError(
		`No document in "${ctx.name}" with _id ${String(id)}`,
		{ collection: ctx.name, id },
	);
}
