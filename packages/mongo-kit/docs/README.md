# `@nxgt/mongo-kit` documentation

The [README](../README.md) is the short version: what the package is, and one
example per area. These pages are the long one.

| Page | Read it when |
| --- | --- |
| [Configuration](guide/configuration.md) | you are describing the databases and the collections of an application, one database or several |
| [The `db` scope](guide/db-scope.md) | you are reading `kit.db.users`, reaching for something only the driver's `Db` has, or wondering when a collection is built |
| [The actor, sessions and transactions](guide/actor-and-transactions.md) | a write has to be stamped with who made it, or several writes have to commit together |
| [Syncing](guide/sync.md) | the collections, their validators and their indexes have to exist on the server |
| [Health](guide/health.md) | a health endpoint has to say whether the databases answer, and how fast |
| [`discoverCollections`](guide/discover-collections.md) | a script has to find the definitions of a repository without importing each one |
| [Errors](guide/errors.md) | something was refused — a configuration, a name, a transaction, a close — and you want the code to switch on |
| [Troubleshooting](troubleshooting.md) | something threw, and you have the message |
| [Roadmap](roadmap.md) | you want to know what is coming, and what will not |
