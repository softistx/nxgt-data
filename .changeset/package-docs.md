---
'@nxgt/drizzle': patch
'@nxgt/meilisearch': patch
'@nxgt/mongo': patch
'@nxgt/mongo-kit': patch
'@nxgt/mongo-meilisearch': patch
'@nxgt/mongo-search-kit': patch
'@nxgt/redis': patch
'@nxgt/s3': patch
---

Every package now ships a `docs/` folder, linked from its npm page.

The README stays the short version: what the package is, how to install it,
and one copy-paste example per area. `docs/` is the long one — a guide page
per area with the option tables, the defaults, what is returned and what is
thrown; a `troubleshooting.md` whose headings are the exact error text you
would paste into a search box, with the line that prevents each one; and a
`roadmap.md` saying what is coming, and what is deliberately not.

`docs` is named in each package's `files`, so it travels in the tarball
rather than living only on GitHub.
