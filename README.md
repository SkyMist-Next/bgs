# Battle.net Game Service

BGS uses CommonJS on **Node.js 26.13.0**, with the supported engine range
`>=26.13.0 <27`. The lockfile was generated using its bundled npm **11.20.0**.
The Node release and stable npm package resolutions were checked on 2026-11-02.
See the [Node release index](https://nodejs.org/download/release/index.json).

## Development

```sh
nvm use
npm ci
npm run lint
npm test
npm run check:runtime
```

`npm ci` permits the bcrypt and microtime native installation scripts via
`package.json#allowScripts`. Their prebuilt N-API binaries are used when available;
source builds require Python 3, make, and a C++ compiler. The optional protobufjs
postinstall script is disabled; loading and encoding are covered by tests.

Startup requires MySQL, Redis with Sentinel, and operator-supplied
`config/database.json` and `config/winston.json`. Workers and Connection additionally
require RabbitMQ; REST never opens a RabbitMQ connection. Configuration uses the
existing environment variables `REDIS_SENTINELS`, `REDIS_MASTER_NAME`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, and
`RABBITMQ_SERVICE_NAME`.

```sh
npm run frontend
npm run rest
npm run service -- authentication
```

Run these commands from the repository root. In development, set
`NODE_ENV=development` and mount/provide `certs/tls.key` and `certs/tls.crt`.
The frontend uses port 1119; REST uses HTTPS port 443 in development and HTTP
port 80 otherwise. Configurations and private keys remain untracked and are
excluded from the Docker build context.

Database configuration accepts `use_env_variable`, with the legacy
`use_env_letiable` spelling retained as a fallback. The conventional key takes
precedence if both are supplied. Table names, SQL column names, model associations,
and entity-ID getters are preserved. Startup uses Sequelize `authenticate()` and
never creates or alters tables by default. The selected database configuration may
set `syncOnStart: true` only in development; other environments reject it before
opening dependencies. Its default is `false`, and non-boolean values are rejected.
Production schema creation and changes require migrations. No migration has been
executed as part of this refactor.
The existing account foreign-key migration now uses Sequelize 6's
`addConstraint(table, { fields, ... })` API with the same constraint definition.

Winston's file configuration retains destinations, levels, exception handling,
and rotation options such as `maxsize`, `maxFiles`, and `tailable`. JSON output
and timestamps default to enabled; `json: false` selects text output and
`timestamp: false` disables timestamps. Development also logs to the console at
debug level. Error messages and stacks are normalized before transport formatting.

## Redis Sentinel configuration and storage

All entrypoints use the same Sentinel-backed primary. Supply configuration through
the environment; never commit credentials or TLS material:

```sh
export REDIS_SENTINELS='[{"host":"sentinel-1","port":26379},{"host":"sentinel-2","port":26379},{"host":"sentinel-3","port":26379}]'
export REDIS_MASTER_NAME='bgs'
export REDIS_DB='0'
# Supply REDIS_USERNAME / REDIS_PASSWORD and, independently,
# REDIS_SENTINEL_USERNAME / REDIS_SENTINEL_PASSWORD through your secret manager.
```

`REDIS_SENTINELS` and `REDIS_MASTER_NAME` are required. Use routable Sentinel and
Redis addresses, preferably DNS names for the seed nodes. `REDIS_DB` defaults to
zero. For either prefix `REDIS` or `REDIS_SENTINEL`, `_TLS=true` enables verified
TLS; optional `_CA_FILE`, `_CERT_FILE`, `_KEY_FILE`, and `_SERVERNAME` configure
trust, client authentication, and the TLS server name. Certificate and key must
be supplied together. Plain TCP is the default. TLS files remain operator mounts.
No standalone/Cluster mode, legacy-state import, or etcd fallback is provided.

Set `WEB_AUTH_URL` to the externally reachable login base URL ending in `/`.
REST publishes it to Redis after startup dependencies succeed. Development defaults
to `https://127.0.0.1:443/bnetserver/login/`; production can instead use a URL already
published into metadata. All REST instances must publish the same external URL.
Missing web-auth configuration makes RPC Logon fail without issuing a challenge.

| Data | Redis representation | Lifetime |
| --- | --- | --- |
| Service hashes, login URL, realm/server catalog | Hash `/aurora/metadata`; fields are the old `/aurora/services/...` paths | Persistent |
| Login ticket | Hash `/aurora/services/AuthenticationService/loginTickets/<ticket>` with `ticket`, `program`, optional `accountId` | 300 seconds from creation |
| Realm-list / realm-join ticket | JSON string at `/aurora/services/GameUtilitiesService/realmListTickets/<hex>` or `realmJoinTickets/<hex>` | Persistent, preserving previous behavior |

Login-ticket creation and expiry are atomic. Binding an account checks that the
ticket is still live and never extends its expiry. Repeating the same binding is
idempotent; binding a different account fails. Account IDs remain decimal strings.
Verification can be repeated until expiry. A password check finishing after expiry
returns the existing HTTP 500 response and cannot recreate the ticket.

The external WoW publisher is not in this checkout. It must write these metadata
fields with `HSET /aurora/metadata <field> <value>` and remove obsolete fields with
`HDEL`, preserving the existing realm/server JSON payloads:

- `/aurora/services/AuthenticationService/WebAuthUrl`: login base URL string.
- `/aurora/services/<ServiceName>/hash`: decimal service hash; workers publish this.
- `/aurora/services/WoWService/subRegions/<id>/virtualRealms/<address>`: realm JSON.
- `/aurora/services/WoWService/subRegions/<id>/gameServers/<id>`: server JSON.

Publish a game-server record before referencing it from a realm. Use a Redis
transaction for related catalog updates. Discovery deduplicates and sorts `HSCAN`
results; it is not a transactional snapshot of concurrent publisher changes.
It scans only metadata, with a 256-entry count hint, a two-second total deadline,
and limits of 10,000 scanned records or 8 MiB. Publishers must keep this catalog
within those limits. An interrupted or oversized scan returns an error, never a
partial list. Realm-ticket population does not enter the discovery scan.
Service hashes describe capabilities; one worker stopping never deletes the shared
registration. Expiry or ownership changes for this persistent metadata are outside
this replacement.

Each process uses one primary connection, no replica reads or local cache,
a 1,024-operation limit, five-second connection attempts, and two-second operation
deadlines. Offline queuing and command replay are disabled; timed-out commands are
aborted before any later submission. A command already sent may have executed even
if its reply was lost. Startup/recovery has a 60-second budget; socket retries use
backoff with jitter capped at two seconds. Sentinel notifications trigger discovery,
with a 30-second periodic refresh to avoid overlapping slow seed discovery loops.

REST binds after initialization, so health endpoints are unreachable during startup.
Once listening, `/alive` remains 200 and `/ready` reports 200 when required dependencies
are healthy, otherwise 500. Probes have a two-second deadline and one-second cache;
a timed-out underlying probe remains coalesced until it actually finishes. Workers
and Connection also require an open, unblocked RabbitMQ connection. Dependency
failures disable new application work while admitted work drains. Redis, sustained
SQL failure, and RabbitMQ blocking have a 60-second recovery budget. Unexpected
broker loss, worker-channel loss, or consumer cancellation initiates shutdown with
a failure exit; there is no in-process AMQP reconnect or replay. A client-owned
channel failure disconnects that client.

SIGINT/SIGTERM immediately disable admission and readiness. A ten-second **total**
graceful budget covers cancellation, workload draining, and dependency closure;
one additional second bounds forced cleanup. Worker replies retain prefetch 16,
backpressure, and the existing acknowledgement behavior. RabbitMQ routing, ticket
lifetimes, RPC handlers, and protocol definitions remain compatible.

Sentinel uses asynchronous replication: recent acknowledged writes can be lost
during failover. Missing tickets fail authentication safely and the client must
retry login. Metadata must be republished if lost. Production Sentinel deployment,
persistence policy, external publisher changes, and native-client acceptance remain
operator/integration work.

```sh
npm run test:redis
```

This opt-in Linux Docker harness creates an isolated bridge network, primary,
replica, and three Sentinels; it removes only its own resources. It uses separate
test passwords, no published host ports, and Redis 8.8.0 pinned by image digest.
Override `REDIS_TEST_IMAGE` to validate another server image. The host must be able
to reach Docker bridge IPs. The harness exercises unavailable seeds, cross-client
state, expiry during password checking, concurrent account binding, primary
promotion, Sentinel loss, readiness, and absence of delayed write replay. It also
prints controlled storage performance measurements. No production deployment runs.

## Production image

```sh
docker build -t bgs:node26-validation .
docker run --rm bgs:node26-validation node scripts/check-runtime.js
```

The Debian Trixie slim dependency stage installs Python 3 and C++ build tools,
then runs `npm ci --omit=dev`. The runtime contains production dependencies and
Tini, without the compiler or development dependencies. Supply the same external
startup command and configuration/certificate mounts as before, for example
`node frontend.js`, `node rest.js`, or `node server.js authentication`.
The image defaults to `NODE_ENV=production`; override it explicitly for development.

The major compatibility changes are Express 5, Winston 3, modern AMQP and native
addons, explicit Sequelize model factories, and replacement of removed finder
methods. Sequelize remains on stable v6; [v7 is still alpha](https://sequelize.org/docs/v7/).
Unused direct dependencies were removed, including `mysql`, `uuid`, and the
application-root and promisification helpers. Express supplies the body parsers.

REST authentication preserves successful `DONE` and invalid-credential `LOGIN`
responses. Invalid/missing credential structures and malformed JSON return 400;
oversized bodies return 413, unsupported encoding/charset returns 415, and
rejected dependencies return 500 without exposing error details. Password checks
use asynchronous bcrypt. RPC authentication awaits ticket reads/writes and
listener publication; each callback channel is closed after use. Error paths
produce one logon callback. The shared protobuf loader resolves BGS imports from
`proto/`, without changing schema files or wire definitions.

## Node upgrade validation recorded on 2026-11-02 (before the Redis replacement)

- Clean `npm ci`, `npm ls --all`, active JavaScript syntax checks, and
  `npm run lint` passed under Node 26.13.0.
- All **31 tests** passed, using controlled MySQL, etcd, and AMQP substitutes.
  Coverage includes model loading and associations, both database URL keys,
  identifiers above JavaScript's safe-integer range, exact protobuf bytes,
  service hashes and method IDs, microsecond timestamps, REST/RPC authentication
  success and failure, legacy bcrypt hashes, concurrent requests, and log output.
- `npm run check:runtime` exercised native bcrypt hashing/comparison and microtime,
  loaded every production dependency, and checked models and protobuf loading.
- The multi-stage production image built successfully on Linux x64. The same
  runtime and production packaging checks passed inside the image; only this architecture is covered.
- `services/wow/realmlist.js` is an unused, incomplete stub referencing a missing
  Realm model. It is unchanged and explicitly excluded from the active-code lint
  and syntax gates. No other application JavaScript is excluded from lint.

For a controlled performance comparison, run:

```sh
node scripts/benchmark-auth.js
```

This uses real HTTP and bcrypt in a separate server process, with MySQL and Redis
substitutes. The historical measurements below predate the Redis replacement;
the storage boundary was also substituted in that run. Both cases use Node 26 and the upgraded libraries; the baseline
selects synchronous verification. One local Linux x64 run used 64 successful
logins, concurrency 8, bcrypt cost 10, and the default four libuv workers:

| Measurement | Synchronous baseline | Asynchronous verification |
| --- | ---: | ---: |
| Successful requests/second | 19.81 | 70.73 |
| Login latency p95, ms | 650.38 | 119.54 |
| Health latency p95, ms | 698.59 | 2.58 |
| Event-loop delay p99, ms | 410.52 | 11.14 |
| Server CPU time, ms | 3237.41 | 3530.61 |
| Peak server RSS, MiB | 73.76 | 75.34 |
| Request errors | 0 | 0 |

These measurements demonstrate the password-verification scheduling change in a
controlled workload. They are not a whole-stack Node 10 comparison or production
capacity acceptance. Results depend on CPU, hash cost, workload, and worker count.

## Dependency audit and remaining acceptance

After a compatible lodash lockfile refresh to 4.18.1, `npm audit` reports
**14 moderate affected packages, zero high/critical**. `npm audit --omit=dev`
reports **two moderate affected packages**: Sequelize and its transitive uuid
8.3.2 dependency, both arising from
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
Removing the unused direct uuid dependency does not remove Sequelize's copy.

Development findings include minimatch
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
and glob [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4),
propagated through ESLint/plugins and sequelize-cli's formatting dependencies.
These counts include affected parent packages, not distinct advisories.
The audit suggests downgrades or changes outside supported dependency ranges;
no forced upgrades, major transitive overrides, or Sequelize downgrade were applied.
Deprecated transitive dottie, uuid, and glob packages remain upstream dependencies.

The Node upgrade did not exercise a live dependency stack. The Redis-specific
validation below is separate from full MySQL/RabbitMQ integration, native-client
acceptance, and production capacity acceptance.

## Redis replacement validation recorded on 2026-11-02

- Clean `npm ci` with Node 26.13.0/npm 11.20.0, `npm ls --all`, active JavaScript
  syntax checks, and lint passed. The unfinished realm-list stub is unchanged.
- All **48 tests** and `npm run check:runtime` passed in an isolated copy using the
  repository's committed protobuf schemas. The working tree already contained
  unrelated schema edits: the original baseline had 16 failing protocol-dependent
  tests (`FNV.update expectes String or Buffer`, missing service descriptor options).
  Those edits were preserved; the current tree's protocol-dependent tests and full
  runtime check remain blocked by that schema/code mismatch. Tests do not substitute
  schemas inside the working tree or claim native-client acceptance.
- The production image builds with 150 installed production packages, Redis 6.3.1,
  and no etcd dependency. Native/dependency/model/protobuf runtime validation passes
  in that image when the committed schemas are mounted read-only; the image's own
  working-tree schemas have the same pre-existing limitation described above.
- The isolated Redis 8.8.0 Sentinel integration passed with one primary, one replica,
  and three Sentinels, including separate authentication credentials, one unreachable
  seed, concurrent account binding, expiry during password verification, primary
  promotion, readiness recovery, Sentinel seed loss, no delayed write replay, and
  shutdown of one client without deleting another client's data.
- No deployment, SQL migration, live MySQL/RabbitMQ acceptance, TLS-server acceptance,
  or native-client acceptance was performed. Dependency audit totals remain 14
  moderate affected packages, including two production packages; no high/critical
  findings were reported by the install/build audits.

A controlled storage comparison used Node 26.13.0/Linux x64 in the same original
application image (`sha256:d3b6afe516283b7f6aa42fca566bbbe916003d4f077888e9077ecc041faf8d09`),
200 operations per case, concurrency eight, 100 realm records, and 25 discovery
warmups. The old adapter ran etcd3 1.1.2 against etcd 3.5.21; the new adapter used
Redis 6.3.1 against Redis 8.8.0 through Sentinel. Redis results used the implementation
in this tree mounted read-only into the same container runtime. The temporary legacy
adapter was not added as an application dependency or compatibility path.

| Backend / workload | Requests/s | p95 ms | Loop p99 ms | Client CPU ms | Peak RSS MiB | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| etcd discovery, no tickets | 416.46 | 28.57 | 19.86 | 447.40 | 114.61 | 0 |
| Redis discovery, no tickets | 1508.08 | 8.19 | 16.49 | 140.22 | 169.13 | 0 |
| etcd discovery, 10,000 tickets | 585.94 | 20.39 | 16.22 | 277.10 | 217.54 | 0 |
| Redis discovery, 10,000 tickets | 1774.44 | 5.09 | 13.42 | 101.27 | 174.28 | 0 |
| etcd authentication storage | 118.98 | 92.35 | 18.73 | 1176.36 | 220.42 | 0 |
| Redis authentication storage | 2992.81 | 4.44 | 10.75 | 54.03 | 174.40 | 0 |

Authentication here measures ticket creation, retrieval, account binding, and
verification, excluding HTTP, SQL, bcrypt, and AMQP. The old flow performs six
storage operations plus lease management; the new flow performs four atomic/read
operations. etcd retained its default persistence while Redis persistence was
disabled in the test environment. These configurations have different durability
properties, so these numbers are a functional migration comparison, not an
equivalent-durability claim or production sizing result. RSS is the process lifetime
peak and therefore includes fixture preparation; host scheduling affects all results.
Use `npm run test:redis` for current storage measurements and separate full-stack
load/failover acceptance before production use.

## Explicit runtime dependencies and validation (2026-11-02)

This section records the earlier dependency-injection stage. Its module-level
startup and SQL synchronization were subsequently replaced by the shared server
lifecycle described below. The historical validation figures in this section refer
to that earlier working-tree snapshot.

Entrypoints own their logger, database, Redis store, and AMQP/server resources.
`require('./models')` exports `createDatabase(config, logger, environment)`;
importing it or a service does not read operator configuration or construct a
database. Services receive dependency objects and retain only the dependencies
they use: the base service takes `logger`; authentication takes `logger`, `models`,
`store`, and `amqpConnection`; account takes `logger` and `models`; game utilities
take `logger` and `store`; connection service and receiver take `logger`, `store`,
and `amqpConnection`. Listeners receive an AMQP connection argument. Each TCP
connection receives its logger, service hash/name, and bound owning-service callback.
There is no application-global fallback; ESLint rejects `global` and `globalThis`
in active JavaScript. The excluded realm-list stub remains unchanged.

- Node 26.13.0: lint and syntax checks passed for all 46 active JavaScript files.
- With the repository schemas, the baseline was 29 passing / 19 failing tests.
  After the refactor, 41 pass / 22 fail: the same 19 failures plus three new
  isolation tests encounter `FNV.update expectes String or Buffer` because the
  schemas lack the descriptor option consumed by the service hash code.
  The runtime check encounters the same mismatch after native/dependency/model checks.
- In temporary validation copies using only the schemas from
  `78cc15f821be50a745da77a864d2b8c548c2de72`, the baseline passed all 48 tests;
  the refactor passed all **63 tests** and `scripts/check-runtime.js`.
  Repository schemas were not changed. New coverage checks independent workers,
  model queries, callback channels, TCP dispatch, loggers, shutdown, import side
  effects, partial startup, and resources that finish opening during shutdown.
- `scripts/redis-integration.js` passed credentials, unavailable seed, cross-client
  state, expiry race, primary failover, Sentinel seed loss, no replay, and independent
  shutdown. The harness removed its test containers.

The existing HTTP/bcrypt benchmark ran three times before and after, with 64
logins, concurrency eight, cost ten, and four libuv workers. The first pair ran in
the working tree; two further pairs used the temporary before/after copies.
Medians for the asynchronous production path were:

| Measurement | Before | After |
| --- | ---: | ---: |
| Successful requests/second | 75.60 | 73.22 |
| Login latency p95, ms | 117.48 | 117.99 |
| Health latency p95, ms | 2.48 | 1.65 |
| Event-loop delay p99, ms | 10.92 | 10.91 |
| Server CPU time, ms | 3351.35 | 3518.13 |
| Peak server RSS, MiB | 59.59 | 59.59 |
| Request errors, every run | 0 | 0 |

Synchronous-control throughput medians were 19.73 and 19.79 requests/second, also
with zero errors. Asynchronous throughput ranges overlapped (68.44–77.15 before,
72.58–77.48 after); these samples show no material regression in this controlled
workload. The benchmark substitutes SQL/Redis and does not measure RPC/AMQP
capacity. Live MySQL/RabbitMQ, native-client, and production-load acceptance remain
separate; this refactor includes no protocol repair or deployment.


## Shared server lifecycle (2026-11-02)

`servers/base-server.js` owns dependencies, readiness, startup cancellation, process
handlers, and cleanup. `ServiceServer` hosts a selected RPC service and receiver;
`NetworkingServer` hosts a plugin and its single TCP/TLS or HTTP/HTTPS listener.
The three entry points export `createServer(options)` without reading operator
configuration, opening connections, or installing process handlers on import.
Their existing npm commands remain the CLI launchers.

Constructors accept `{ config, logger, factories }` and remain inert. `start()`
returns the same promise during startup or while running. `stop(reason)` returns
the shared `closed` promise, which resolves to `{ exitCode, forced, errors }`;
passing an Error marks failure. States are `created`, `starting`, `running`,
`stopping`, and `stopped`. Startup failure goes through cleanup, and stopped
instances cannot restart. `isReady()` is asynchronous; `isAccepting()` is the
synchronous admission gate. Temporary degradation changes readiness, not state.

Independent dependencies connect concurrently within one 60-second startup
budget. `database`, `store`, and `amqp` factories receive configuration, logger,
environment, cancellation signal, and fatal-error callback. They may return
resources or promises. Resources and unresolved acquisitions remain owned after
a waiter times out; late arrivals are closed without activating the server.
Injected databases can provide `forceClose()` or a `forceDatabase` factory hook.
The default database tracks native connections so forced cleanup destroys active
MySQL sockets and rejects connections that arrive afterward.

The protected hooks are `onStart(dependencies, signal)`, `onStopAccepting()`,
`onDrain()`, and `onForceClose()`. Public methods enforce shutdown ordering:
disable admission, cancel startup, initiate listener/consumer closure, drain
admitted work and pending output, close workload resources, then close dependencies.
All cleanups are attempted even if another fails. The owned SIGINT, SIGTERM, and
unhandled-rejection handlers are installed at startup and removed during cleanup.
Programmatic `stop()` never exits the process. CLI launchers await `closed`, set
the exit status, and force process exit when forced cleanup was necessary.
Deadline and probe helpers live in `utils/deadline.js` and
`utils/dependency-probe.js`; Redis and its integration harness do not import servers.

A networking plugin implements:

| Method | Responsibility |
| --- | --- |
| `initialize(context)` | Return an unbound Node server after initialization. |
| `stopAccepting()` | Disable new application work on all connections. |
| `drain()` | Complete admitted handlers/output and close owned sessions/channels. |
| `forceClose()` | Terminate remaining workload resources. |

The context supplies connected dependencies, `isReady`, `isAccepting`, `signal`,
and `onFatal`. The contract is checked before acquiring dependencies. The networking
host attaches listener errors and tracks raw sockets, including unfinished TLS
handshakes, before binding. It starts listener closure, drains the plugin, and then
waits for listener closure. REST publishes `WEB_AUTH_URL` before listening, tracks
asynchronous authentication through completion even after client disconnect, and
retires idle HTTP connections. Connection drains local handlers, worker replies,
socket output, broker backpressure, and owned channels before shared AMQP closure.
REST/local RPC handler sets are limited to 1,024, forwarded calls to 128 per client,
and TCP queued socket output to 1 MiB; overflow rejects work or closes the client.

Validation used Node 26.13.0 and the current repository schemas. The pre-refactor
working tree passed 99 tests and runtime checks; the earlier schema incompatibility
was absent, so schema substitution was unnecessary. The refactor passed lint,
changed-file syntax checks, the complete test suite, and runtime checks. New tests
cover independent instances, repeated start/stop, partial startup, late acquisitions,
signal removal, cleanup failures, bounded probes, worker cancellation/backpressure,
real bind failures, HTTP keep-alive and disconnected clients, pending TCP replies,
stalled output, development HTTPS/TLS, unfinished handshakes, and database defaults.
The isolated Docker Sentinel integration passed credentials, unavailable seed,
cross-client state, expiry races, primary promotion, seed loss, no replay, and
independent shutdown, and removed its test resources.

```sh
npm run lint
npm test
npm run check:runtime
npm run test:redis
node scripts/benchmark-auth.js
```

The benchmark now includes the production networking wrapper in addition to the
existing synchronous and asynchronous controls. Three sequential before/after
pairs used the same 64 logins, concurrency eight, bcrypt cost ten, four libuv
workers, and controlled SQL/Redis dependencies. Medians were:

| Measurement | Before: asynchronous REST | After: NetworkingServer + RestPlugin |
| --- | ---: | ---: |
| Successful requests/second | 73.35 | 76.79 |
| Login latency p95, ms | 120.15 | 116.87 |
| Health latency p95, ms | 2.05 | 1.78 |
| Event-loop delay p99, ms | 10.86 | 11.02 |
| Server CPU time, ms | 3481.20 | 3316.23 |
| Peak server RSS, MiB | 59.41 | 59.90 |
| Errors, every run | 0 | 0 |

Before/after throughput ranges overlapped (72.09–76.06 and 73.60–78.03 requests/s).
These samples show no evident regression; they do not establish a production
speedup. Controlled active HTTP shutdown completed about 1–2 ms after releasing
the admitted handler. With a 20 ms graceful test budget, stalled TCP output and
stalled authentication forced cleanup in about 21 ms. A separate measurement of
the default budgets with active HTTP and stuck SQL cleanup completed in about
11 seconds, with a failure exit status and forced cleanup.

The baseline snapshot is at `/tmp/bgs-server-refactor-baseline`, and paired
benchmark/default-shutdown evidence is at `/tmp/bgs-server-refactor-validation`
in this workspace session. Existing protobuf files/deletions and the excluded
realm-list stub were preserved byte for byte. No commit, deployment, or migration
was made. Live MySQL/RabbitMQ interruptions and worker restarts, native-client
acceptance, and production-load testing remain separate integration acceptance.

## Kubernetes deployment

Use the sibling `bgs-chart/` production/local profiles. `BGS_PORT` overrides the
application port, `BGS_TLS=true|false` controls TLS independently of NODE_ENV, and
`BGS_HEALTH_PORT` enables internal `/alive` and `/ready` probes. Set Winston
`console: true` for container logs. The chart supplies these settings.

`scripts/deploy.js bootstrap|migrate|wait` provides image-owned credential
bootstrap, serialized schema migrations, and read-only startup gating. Migration
Jobs require the chart's scoped Kubernetes service account. No runtime package
installation or Sequelize synchronization is performed.
