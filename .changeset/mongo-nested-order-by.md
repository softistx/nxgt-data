---
'@nxgt/mongo': minor
---

`paginateByCursor`'s `orderBy` accepts a dotted path into a nested object (`'quantity.baseQuantity'`), typed against the document by the new `OrderPathOf<Def>`: a path that does not exist is a compile error. The cursor carries the nested value and the `_id` tiebreak.
