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

Startup requires MySQL, RabbitMQ, Redis with Sentinel, operator-supplied
`config/database.json` and `config/winston.json`, and the existing environment
variables `REDIS_SENTINELS`, `REDIS_MASTER_NAME`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, and
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
and entity-ID getters are preserved. Startup retains its existing Sequelize
`sync()` behavior. No migration has been executed as part of this upgrade.
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

REST `/alive` remains 200. `/ready` reports 200 only after initialization and current
primary/SQL probes succeed, otherwise 500; probes are coalesced and cached for at
most one second. Frontend and workers await Redis, SQL initialization, and AMQP
before accepting work. Redis outages fail requests promptly; the primary health
monitor initiates shutdown if recovery exceeds its budget. SIGINT/SIGTERM stop new
work and drain accepted work for up to ten seconds, then close dependencies; a
one-second forced-cleanup budget precedes process exit. Worker replies respect AMQP
backpressure and prefetch is bounded at 16. Existing RabbitMQ routing and broader
frontend protocol behavior are not redesigned here.

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
