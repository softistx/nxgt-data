/** One hook, as the runner calls it: typing is `CollectionHooks`' job. */
export type Hook = (
	value: unknown,
	context: Record<string, unknown>,
) => unknown;

/** One hook set, as the runner reads it: any hook, by name. */
export type HookSet = Readonly<Record<string, Hook | undefined>>;

/**
 * `hooks` as the options give it — one set, several, or none — as a list.
 *
 * Its own module, with no imports, because the context needs it and the hook
 * runner needs the writes, which need the context.
 */
export function hookSetsOf(hooks: unknown): readonly HookSet[] {
	if (hooks === undefined) return [];
	return (Array.isArray(hooks) ? hooks : [hooks]) as HookSet[];
}
