import { coercedValues, coerceId } from '../coerce';
import type { CollectionContext } from '../context';
import { coerced, type Fields, requireFilter } from '../filters';
import { upsert } from '../operations/upsert';
import {
	create,
	createMany,
	deleteMany,
	deleteOne,
	hardDelete,
	hardDeleteMany,
	restore,
	update,
	updateMany,
} from '../operations/writes';
import { keptByCollection, refuseId } from '../stamp-writes';
import type { WriteOperation } from './types';

/**
 * The collection a hook is handed, fetched when the hook runs: it is the
 * proxy `build` returns, which does not exist yet while its methods are put
 * together.
 */
export type Self = () => unknown;

function contextOf(
	ctx: CollectionContext,
	self: Self,
	operation: WriteOperation,
	extra: Fields = {},
): Fields {
	return {
		operation,
		collection: self(),
		session: ctx.session,
		actor: ctx.actor,
		...extra,
	};
}

/** Runs one `before` hook of every set, each seeing what the last returned. */
async function before<Args extends Fields>(
	ctx: CollectionContext,
	name: string,
	args: Args,
	context: Fields,
): Promise<Args> {
	let current = args;
	for (const set of ctx.hooks) {
		const hook = set[name];
		if (!hook) continue;
		const replaced = await hook(current, context);
		if (replaced !== undefined) current = replaced as Args;
	}
	return current;
}

async function after(
	ctx: CollectionContext,
	name: string,
	result: unknown,
	context: Fields,
	args: Fields,
): Promise<void> {
	for (const set of ctx.hooks) {
		const hook = set[name];
		if (hook) await hook(result, { ...context, ...args });
	}
}

export async function hookedCreate(
	ctx: CollectionContext,
	self: Self,
	values: unknown,
): Promise<Fields> {
	const context = contextOf(ctx, self, 'create');
	const args = await before(
		ctx,
		'beforeCreate',
		{ values: coercedValues(ctx, values) },
		context,
	);
	const document = await create(ctx, args.values);
	await after(ctx, 'afterCreate', document, context, args);
	return document;
}

/** `beforeCreate` and `afterCreate` once per document, around one insert. */
export async function hookedCreateMany(
	ctx: CollectionContext,
	self: Self,
	values: readonly unknown[],
): Promise<Fields[]> {
	const context = contextOf(ctx, self, 'createMany');
	const argsList: { values: unknown }[] = [];
	for (const value of values) {
		argsList.push(
			await before(
				ctx,
				'beforeCreate',
				{ values: coercedValues(ctx, value) },
				context,
			),
		);
	}
	const documents = await createMany(
		ctx,
		argsList.map((args) => args.values),
	);
	for (const [index, document] of documents.entries()) {
		await after(ctx, 'afterCreate', document, context, argsList[index] ?? {});
	}
	return documents;
}

/**
 * The document an insert landed, as the write that landed it.
 *
 * `afterCreate` is told what was created, and what was created is the
 * document less the fields the collection keeps for itself — the ones a
 * `create` may not be given either. Built from the document rather than from
 * the caller's values, which are partial and would not be a create.
 */
function createdValues(ctx: CollectionContext, document: Fields): Fields {
	const kept = new Set(keptByCollection(ctx));
	const values: Fields = {};
	for (const [field, value] of Object.entries(document)) {
		if (field === 'id' || kept.has(field)) continue;
		values[field] = value;
	}
	return values;
}

export async function hookedUpsert(
	ctx: CollectionContext,
	self: Self,
	filter: unknown,
	values: unknown,
): Promise<Fields> {
	// The caller's own values are checked before any hook sees them, as the
	// filters are in `hookedUpdateMany`; what a hook returns is checked again
	// by the operation.
	refuseId(ctx, 'upsert', values);
	const context = contextOf(ctx, self, 'upsert');
	const args = await before(
		ctx,
		'beforeUpsert',
		{ filter: coerced(ctx, filter), values: coercedValues(ctx, values) },
		context,
	);
	const { document, inserted } = await upsert(ctx, args.filter, args.values);
	// Which half ran is known only now, so this is where the pair is told
	// apart. The context still says `upsert`: that is what was called.
	if (inserted) {
		await after(ctx, 'afterCreate', document, context, {
			values: createdValues(ctx, document),
		});
	} else {
		await after(ctx, 'afterUpdate', document, context, {
			id: document._id,
			patch: args.values,
		});
	}
	return document;
}

export async function hookedUpdate(
	ctx: CollectionContext,
	self: Self,
	id: unknown,
	patch: unknown,
): Promise<Fields> {
	refuseId(ctx, 'update', patch);
	const context = contextOf(ctx, self, 'update');
	const args = await before(
		ctx,
		'beforeUpdate',
		{ id: coerceId(ctx, id), patch },
		context,
	);
	const document = await update(ctx, args.id, args.patch);
	await after(ctx, 'afterUpdate', document, context, args);
	return document;
}

export async function hookedUpdateMany(
	ctx: CollectionContext,
	self: Self,
	filter: unknown,
	patch: unknown,
): Promise<number> {
	// The caller's filter is checked before any hook runs: a hook that narrows
	// it turns `{}` into a filter that is no longer empty, and the guard would
	// then let an update of every document through.
	requireFilter(ctx, 'updateMany', filter);
	refuseId(ctx, 'updateMany', patch);
	const context = contextOf(ctx, self, 'updateMany');
	const args = await before(
		ctx,
		'beforeUpdateMany',
		{ filter: coerced(ctx, filter), patch },
		context,
	);
	const count = await updateMany(ctx, args.filter, args.patch);
	await after(ctx, 'afterUpdateMany', count, context, args);
	return count;
}

/** `delete` and `hardDelete`, which share their hooks. */
export async function hookedDelete(
	ctx: CollectionContext,
	self: Self,
	id: unknown,
	hard: boolean,
): Promise<Fields> {
	const goesForGood = hard || !ctx.softDeletes;
	const context = contextOf(ctx, self, hard ? 'hardDelete' : 'delete', {
		hard: goesForGood,
	});
	const args = await before(
		ctx,
		'beforeDelete',
		{ id: coerceId(ctx, id) },
		context,
	);
	const document = hard
		? await hardDelete(ctx, args.id)
		: await deleteOne(ctx, args.id);
	await after(ctx, 'afterDelete', document, context, args);
	return document;
}

/** `deleteMany` and `hardDeleteMany`, which share their hooks. */
export async function hookedDeleteMany(
	ctx: CollectionContext,
	self: Self,
	filter: unknown,
	hard: boolean,
): Promise<number> {
	const method = hard ? 'hardDeleteMany' : 'deleteMany';
	// Before the hooks, as in `hookedUpdateMany`.
	requireFilter(ctx, method, filter);
	const goesForGood = hard || !ctx.softDeletes;
	const context = contextOf(ctx, self, method, { hard: goesForGood });
	const args = await before(
		ctx,
		'beforeDeleteMany',
		{ filter: coerced(ctx, filter) },
		context,
	);
	const count = hard
		? await hardDeleteMany(ctx, args.filter)
		: await deleteMany(ctx, args.filter);
	await after(ctx, 'afterDeleteMany', count, context, args);
	return count;
}

export async function hookedRestore(
	ctx: CollectionContext,
	self: Self,
	id: unknown,
): Promise<Fields> {
	const context = contextOf(ctx, self, 'restore');
	const args = await before(
		ctx,
		'beforeRestore',
		{ id: coerceId(ctx, id) },
		context,
	);
	const document = await restore(ctx, args.id);
	await after(ctx, 'afterRestore', document, context, args);
	return document;
}
