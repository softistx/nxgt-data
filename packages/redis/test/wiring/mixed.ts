/**
 * One module exporting every kind, as an application that keeps its
 * definitions together does: each slot of the configuration takes the whole
 * module and keeps only what is its own.
 */
export { users } from './caches';
export { created } from './channels';
export { orders } from './idempotency';
export { login } from './limits';
