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

Startup still requires MySQL, RabbitMQ, etcd, operator-supplied
`config/database.json` and `config/winston.json`, and the existing environment
variables `ETCD_HOST`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, and
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

## Validation recorded on 2026-11-02

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

This uses real HTTP and bcrypt in a separate server process, with MySQL and etcd
substitutes. Both cases use Node 26 and the upgraded libraries; the baseline
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

No live MySQL/RabbitMQ/etcd stack was started, no deployment was performed, and
no schema migration was run. Live authentication, worker restarts, dependency
interruptions, failover, native-client acceptance, and production load remain
separate checks. `/ready` retains the existing database-sync flag; this migration
does not establish dependency-aware readiness, graceful draining, shared-state
ownership, retry bounds, or broader high-availability guarantees.
