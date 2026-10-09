---
"@nxgt/backup": patch
"@nxgt/drizzle": patch
"@nxgt/drizzle-meilisearch": patch
"@nxgt/meilisearch": patch
"@nxgt/mongo": patch
"@nxgt/mongo-backup": patch
"@nxgt/mongo-meilisearch": patch
"@nxgt/redis": patch
"@nxgt/s3": patch
---

The declaration files now import each other with a `.js` extension, so a project with `moduleResolution: "nodenext"` (or `node16`) sees every export. Before, a name re-exported through a relative module was missing there (TS2305), as `@nxgt/mongo`'s were.
