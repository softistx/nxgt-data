import { connectMongo } from '../../src';

export async function health() {
	await using mongo = await connectMongo('mongodb://localhost/app', {
		appName: 'api',
	});
	const result = await mongo.ping({ timeoutMS: 500 });
	// @ts-expect-error the latency is only there once `ok` says so
	result.latencyMs;
	if (result.ok) return result.latencyMs;
	// @ts-expect-error a failed ping has no latency
	return result.latencyMs ?? result.error;
}

export async function typo() {
	const mongo = await connectMongo('mongodb://localhost/app');
	// @ts-expect-error timeoutMS, as the driver spells it
	await mongo.ping({ timeoutMs: 500 });
	// @ts-expect-error a URI is a string
	await connectMongo(27017);
}

// @ts-expect-error the driver's options, typed: no such option
void connectMongo('mongodb://localhost/app', { poolSize: 5 });
