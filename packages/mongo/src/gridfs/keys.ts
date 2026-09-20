/**
 * Where the type and the digest live: GridFS keeps no field for either, so
 * this package puts both in the file's `metadata`.
 *
 * Their own module, and a leaf one — it imports nothing from this folder.
 * They were on `handle.ts`, which reads the chunks; once `chunks.ts` had to
 * reach `indexes.ts` for the missing-index warning, and `indexes.ts` needed
 * `HASH_KEY` for the digest index, that made a three-module ring:
 * `chunks → indexes → handle → chunks`. It worked only because nothing read
 * the constant at module scope, which is a `ReferenceError` waiting for the
 * first line that does. From here the folder points one way.
 */
export const TYPE_KEY = 'contentType';
export const HASH_KEY = 'sha256';
