import { WiringError } from '../../errors/wiring-error';

/**
 * What `defineMongo` throws for one database: a `CONFIG` refusal, naming the
 * database and, when one is at fault, the key. Shared by the collection
 * checks and the bucket checks, which is why it is a module of its own.
 */
export const refuse = (name: string, said: string, key?: string): never => {
	throw new WiringError('CONFIG', `defineMongo: database "${name}" ${said}`, {
		database: name,
		key,
	});
};
