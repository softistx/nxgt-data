import { coerceFields } from '../collection/coerce';
import type { BucketContext } from './context';
import { HASH_KEY, TYPE_KEY } from './keys';

/** The metadata a write stores: the caller's, checked, plus our two fields. */
export function metadataFor(
	ctx: BucketContext,
	given: unknown,
	type: string | undefined,
): Record<string, unknown> {
	const asked = (given ?? {}) as Record<string, unknown>;
	if (TYPE_KEY in asked || HASH_KEY in asked) {
		throw new TypeError(
			`put: "${TYPE_KEY}" and "${HASH_KEY}" are kept by "${ctx.name}" ` +
				'itself. The content type is the `type` option, and the digest is ' +
				"the bucket's to compute.",
		);
	}
	const coerced = ctx.coerces ? coerceFields(ctx.kinds, asked) : { ...asked };
	const schema = ctx.definition.metadata;
	const checked =
		ctx.parses && schema
			? (schema.parse(coerced) as Record<string, unknown>)
			: coerced;
	return type === undefined ? checked : { ...checked, [TYPE_KEY]: type };
}
