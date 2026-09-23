/**
 * What the types refuse. Checked by `tsc --noEmit`, never run.
 *
 * A `@ts-expect-error` that stops being an error fails the build, so each
 * case is a claim the compiler keeps honest. Type safety is what the compiler
 * rejects, not what the README says.
 */

import { defineCache } from '@nxgt/redis';
import { z } from 'zod';
import { defineConfig } from '../../src/config/define-config';
import { connectKit } from '../../src/kit/connect-kit';
import type { KitOf } from '../../src/kit/types';
import * as caches from '../caches';
import * as channels from '../channels';

const uri = 'redis://127.0.0.1:6379';

async function soleInstance() {
	const kit = await connectKit(defineConfig({ uri, caches, channels }));

	// A cache that is not wired.
	// @ts-expect-error
	kit.cache.nope;

	// A channel that is not wired.
	// @ts-expect-error
	kit.channels.nope;

	// `users` is keyed by a string id, not an object.
	// @ts-expect-error
	await kit.cache.users.get({ id: 'ada' });

	// `seats` is keyed by an object, not a string.
	// @ts-expect-error
	await kit.cache.seats.get('ada');

	// A field the schema does not have.
	// @ts-expect-error
	await kit.cache.users.set('ada', { id: 'ada', email: 'a@b.c', admin: true });

	// A missing required field.
	// @ts-expect-error
	await kit.cache.users.set('ada', { id: 'ada' });

	// `created` carries a user, not an id alone.
	// @ts-expect-error
	await kit.channels.created.publish({ id: 'ada' });

	// The handler is given the payload the schema describes.
	await kit.channels.created.subscribe((payload) => {
		// @ts-expect-error
		payload.admin;
	});

	// An instance this configuration does not name.
	// @ts-expect-error
	kit.instances.pubsub;

	// The same, on a lock.
	// @ts-expect-error
	await kit.lock('k', () => 1, { on: 'pubsub' });

	// These are the shapes that must keep compiling.
	await kit.cache.users.set('ada', { id: 'ada', email: 'a@b.c', seats: 1 });
	// `seats` has a `.default()`: a write may leave it out, a read has it.
	await kit.cache.users.set('ada', { id: 'ada', email: 'a@b.c' });
	const read = await kit.cache.users.remember('ada', () => ({
		id: 'ada',
		email: 'a@b.c',
	}));
	const seatCount: number = read.seats;
	void seatCount;
	await kit.cache.seats.get({ org: 'acme', user: 'ada' });
	await kit.channels.created.publish({ id: 'ada', email: 'a@b.c', seats: 1 });
	await kit.lock('k', () => 1);
	kit.instances.default.client;
	await kit.close();
}

async function severalInstances() {
	const kit = await connectKit(
		defineConfig({
			instances: {
				cache: { uri, caches },
				pubsub: { uri, channels },
			},
		}),
	);

	// `kit.cache` is `never` with more than one instance: naming the Redis is
	// the only way, and the compiler says so before anything runs.
	// @ts-expect-error
	kit.cache.users;

	// @ts-expect-error
	kit.channels.created;

	// And `never` itself, not merely a scope with no key on it — the two read
	// the same in an error message and are not the same type.
	const noCache: never = kit.cache;
	const noChannels: never = kit.channels;
	void noCache;
	void noChannels;

	// `pubsub` wires no cache.
	// @ts-expect-error
	kit.instances.pubsub.cache.users;

	// `cache` wires no channel.
	// @ts-expect-error
	kit.instances.cache.channels.created;

	// A lock must name which Redis it lives on, and only one this kit has.
	// @ts-expect-error
	await kit.lock('k', () => 1, { on: 'nope' });

	// These must keep compiling.
	await kit.instances.cache.cache.users.get('ada');
	await kit.instances.pubsub.channels.created.publish({
		id: 'ada',
		email: 'a@b.c',
		seats: 1,
	});
	await kit.lock('k', () => 1, { on: 'cache' });
	const answered = await kit.ping();
	answered.cache.ok;
	answered.pubsub.ok;
	await kit.close();
}

/**
 * `KitOf` types a kit from the configuration alone — a service that is handed
 * one, rather than reading `Awaited<ReturnType<typeof connectKit>>` back.
 *
 * It is a claim about what `KitConfig` carries: the instances it freezes hold
 * `caches` as an optional field, so reading the caches back off that shape
 * alone gives an empty scope. These lines fail the build if that regresses.
 */
function kitFromConfig() {
	const config = defineConfig({ uri, caches, channels });
	type Kit = KitOf<typeof config>;

	return (kit: Kit) => {
		// A cache this configuration does not wire.
		// @ts-expect-error
		kit.cache.nope;

		// These must keep compiling.
		void kit.cache.users.get('ada');
		void kit.channels.created.name;
		void kit.instances.default.client;
	};
}

function configRefusals() {
	// A cache under a key that is not a definition is simply not wired, which
	// is not an error — but asking for it is.
	const kit = defineConfig({ uri, caches });
	kit.instances.default.uri;

	const orphan = defineCache({
		name: 'orphan',
		key: (id: string) => id,
		ttl: 5,
		schema: z.object({ id: z.string() }),
	});

	// An option the config does not have.
	// @ts-expect-error
	defineConfig({ uri, caches, nope: true });

	// `prefix` is a string.
	// @ts-expect-error
	defineConfig({ uri, caches, prefix: 5 });

	// These must keep compiling.
	defineConfig({ uri, caches: { orphan } });
	defineConfig({ uri, prefix: 'myapp', caches, channels });
	defineConfig({ instances: { a: { uri, caches } } });
}

export { configRefusals, kitFromConfig, severalInstances, soleInstance };
