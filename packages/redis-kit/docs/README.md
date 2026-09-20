# `@nxgt/redis-kit` documentation

An application's Redis wiring in one object, on top of
[`@nxgt/redis`](https://www.npmjs.com/package/@nxgt/redis): the caches, the
channels, the lock and the client are its, and this package is where an
application says which of them it has and where they live.

| Page | Read it when |
| --- | --- |
| [Configuration](guide/configuration.md) | you are describing where Redis is and what is wired on it, and deciding what the deployment's prefix should be |
| [Caches](guide/caches.md) | you are reading `kit.cache.users`, and want the keys it writes, what `remember` promises, and what the types refuse |
| [Channels](guide/channels.md) | one process publishes an event and another reacts to it, and somebody has to close the subscription |
| [Locks and health](guide/locks-and-health.md) | a job must run once, or a health route has to say whether Redis answers |
| [Instances and closing](guide/instances.md) | an application talks to more than one Redis, or you are deciding who closes which client |
| [Troubleshooting](troubleshooting.md) | something threw, and you have the message in front of you |
| [Roadmap](roadmap.md) | you want to know what is coming, and what has been ruled out |

The [README](../README.md) is the short version: install, one example per
area, and the traps in one line each.
