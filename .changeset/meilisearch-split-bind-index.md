---
'@nxgt/meilisearch': patch
---

Refactor, nothing public moved: `bindIndex` is split into a data-only `index/context.ts` and `index/operations/reads.ts` and `writes.ts`, and is now a thin assembler. No behaviour and no export changed — the declarations are the same and the 45 specs are untouched.
