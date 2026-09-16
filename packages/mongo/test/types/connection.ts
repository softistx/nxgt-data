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

// @ts-expect-error the driver's options, typed: no such option
void connectMongo('mongodb://localhost/app', { poolSize: 5 });
