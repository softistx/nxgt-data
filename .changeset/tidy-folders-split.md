---
'@nxgt/mongo': patch
---

Internal: `src/collection/` is split into subject folders (`operations/`,
`hooks/`, `changes/`). Nothing public moved: the exports, their types and
their behaviour are unchanged, and the test counts are the same on both
sides.
