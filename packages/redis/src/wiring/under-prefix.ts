import { type InstanceContext, prefixed } from './context';

/**
 * A definition with this instance's prefix in its name.
 *
 * A copy, never a mutation: the definition came from the application's own
 * module and is shared by every Redis that wires it — two Redis objects with two
 * prefixes on one definition is an ordinary thing to want in a test.
 */
export function underPrefix<D extends { name: string }>(
	instance: InstanceContext,
	definition: D,
): D {
	return Object.freeze({
		...definition,
		name: prefixed(instance, definition.name),
	});
}
