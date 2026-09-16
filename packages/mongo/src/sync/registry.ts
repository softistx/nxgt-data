import type { AnyCollectionDefinition } from '../definition/define-collection';

/**
 * Every collection `defineCollection` has built, by name.
 *
 * It is what lets `syncAll` sync a whole application without a list anyone
 * has to keep up to date: importing the module that defines a collection is
 * what registers it, so a collection nobody imports is a collection nobody
 * uses.
 *
 * Keyed by name, and the **last** definition under a name wins. Two
 * definitions of one collection is a mistake, but refusing it here would
 * refuse a module being evaluated twice — which a test suite and a dev server
 * with hot reloading both do, and neither is the mistake.
 */
const definitions = new Map<string, AnyCollectionDefinition>();

/** Adds a definition to the registry. `defineCollection` calls this. */
export function registerCollection(definition: AnyCollectionDefinition): void {
	definitions.set(definition.name, definition);
}

/** Every registered definition, in the order their names were first seen. */
export function registeredCollections(): AnyCollectionDefinition[] {
	return [...definitions.values()];
}

/** Empties the registry. For a test that needs to start from nothing. */
export function clearCollectionRegistry(): void {
	definitions.clear();
}
