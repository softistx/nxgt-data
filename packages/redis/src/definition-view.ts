/**
 * A definition as a bound object shows it: `key` is declared as a **method**,
 * so it is checked bivariantly in `P` and `BoundRateLimit<{ ip: string }>`
 * still assigns to `BoundRateLimit<unknown>`, as before `definition` existed.
 * A property `key: (params: P) => string` would make the bound type strictly
 * contravariant in `P`.
 */
export type DefinitionView<D, P> = Omit<D, 'key'> & {
	key(params: P): string;
};
