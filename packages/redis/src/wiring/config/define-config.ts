import { checkInstance } from './checks';
import type {
	Checked,
	InstanceConfig,
	KitConfig,
	KitConfigInput,
} from './types';

/**
 * The instances of a config, whichever shape it was written in.
 *
 * One Redis is the configuration itself, and takes the name `default` — so
 * everything below this line has a single case to handle, and
 * `kit.instances.default` is always a way to reach it.
 */
function instancesOf(
	config: KitConfigInput,
): Record<string, InstanceConfig<object, object>> {
	if ('instances' in config && config.instances !== undefined) {
		return config.instances as Record<string, InstanceConfig<object, object>>;
	}
	return { default: config as InstanceConfig<object, object> };
}

/**
 * Checks a configuration and freezes it.
 *
 * It connects to nothing and reads no environment variable: an application
 * writes `uri: process.env.REDIS_URL!` itself, so the one place a URL is
 * read is the application's, and this package never has to explain which
 * variable it looked at.
 *
 * ```ts
 * import * as caches from './caches';
 * import * as channels from './channels';
 *
 * export const config = defineConfig({
 *   uri: process.env.REDIS_URL!,
 *   prefix: 'myapp:prod',
 *   caches,
 *   channels,
 * });
 * ```
 *
 * The checks run again in `connectKit`, on the same configuration: a config
 * can be built in one file and connected in another, and the second is where
 * the sentence is useful.
 */
export function defineConfig<const C extends KitConfigInput>(
	config: C & Checked<C>,
): KitConfig<C> {
	const instances = instancesOf(config);
	if (Object.keys(instances).length === 0) {
		throw new TypeError(
			'defineConfig: `instances` is empty. Give it one, or write the single ' +
				'instance as the configuration itself.',
		);
	}
	for (const [name, instance] of Object.entries(instances)) {
		checkInstance('defineConfig', name, instance);
	}
	return Object.freeze({
		instances: Object.freeze({ ...instances }),
	}) as KitConfig<C>;
}
