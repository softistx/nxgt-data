import { KitError } from '../errors/kit-error';

/**
 * What `defineConfig` throws for one database: a `CONFIG` refusal, naming the
 * database and, when one is at fault, the key. Shared by the collection
 * checks and the bucket checks, which is why it is a module of its own.
 */
export const refuse = (name: string, said: string, key?: string): never => {
	throw new KitError('CONFIG', `defineConfig: database "${name}" ${said}`, {
		database: name,
		key,
	});
};
