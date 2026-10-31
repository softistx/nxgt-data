import { version } from 'mongodb/package.json';

/**
 * Whether the installed driver honours `timeoutMS`: mongodb 7.8 ignores it
 * (the option is accepted and does nothing), 7.6 and below apply it.
 */
const [major = 0, minor = 0] = version.split('.').map(Number);
export const driverHonoursTimeoutMS = major === 7 && minor < 8;

/**
 * The `name` of the error `ping` reports for a server too slow: the driver's
 * own below mongodb 7.8, `ConnectionError` (the timer's) from 7.8 on.
 */
export const slowPingErrorName = driverHonoursTimeoutMS
	? 'MongoOperationTimeoutError'
	: 'ConnectionError';
