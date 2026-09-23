---
---

Refactor of `@nxgt/meilisearch`, nothing published: `bindIndex` is split into a data-only `index/context.ts` and `index/operations/reads.ts` and `writes.ts`, and is now a thin assembler. No behaviour and no export changed — `dist/index.d.ts` is byte-identical and the 45 specs are untouched — so no consumer sees it and no version is bumped.
