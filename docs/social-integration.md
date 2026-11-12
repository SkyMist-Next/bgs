# Social integration fixture

`scripts/social-integration.js` exercises the social services against **existing**
MariaDB, Redis and RabbitMQ fixtures. It never starts containers, installs
dependencies, builds images or contacts Kubernetes. Run it serially with Node 26
from the `bgs/` directory.

## Run

All endpoints are loopback. All four ports are required before the script opens
any connections. These are the current disposable fixture ports, not production
defaults:

```sh
BGS_SOCIAL_TEST_PORT=33317 \
BGS_SOCIAL_TEST_REDIS_PORT=33318 \
BGS_SOCIAL_TEST_AMQP_PORT=33319 \
BGS_SOCIAL_TEST_MANAGEMENT_PORT=33320 \
/tmp/bgs-node26/bin/node scripts/social-integration.js
```

The respective `REALM_TEST_DB_PORT`, `REALM_TEST_REDIS_PORT`,
`REALM_TEST_AMQP_PORT` and `REALM_TEST_MANAGEMENT_PORT` variables are accepted as
fallbacks, matching the existing realm fixture. MariaDB defaults to user `root`
with an empty password; override with `BGS_SOCIAL_TEST_DB_USER` and
`BGS_SOCIAL_TEST_DB_PASSWORD`. RabbitMQ management defaults to `fixture` /
`local-validation-only`; override with `BGS_SOCIAL_TEST_BROKER_USER` and
`BGS_SOCIAL_TEST_BROKER_PASSWORD`. That fixture principal must be able to create
vhosts, users and permissions. RabbitMQ must support quorum queues and enable
the management API. The AMQP and management ports must address the same broker.

Redis supports `BGS_SOCIAL_TEST_REDIS_USERNAME`,
`BGS_SOCIAL_TEST_REDIS_PASSWORD` and `BGS_SOCIAL_TEST_REDIS_DB` (default `0`).
No `FLUSHDB`, wildcard deletion or existing broker resource mutation is used.

For checks without any network connections:

```sh
/tmp/bgs-node26/bin/node scripts/social-integration.js --check
/tmp/bgs-node26/bin/node node_modules/eslint/bin/eslint.js scripts/social-integration.js
```

`--check` validates environment guards, authenticated world lease fixtures,
protobuf requests, uint64 listener objects, realm request envelopes and migration
exports. It does not establish integration acceptance.

## Scenario and real dependencies

Alice and Cara represent direct 15595 sessions. Bob represents a 26972 world
session. Account/game IDs exceed JavaScript's safe integer range and remain
decimal strings; the friends listener object uses the maximum uint64 value.

1. Direct requests cross `ServiceReceiver` through `battlenet_aurora_bus`.
   Bob uses a separately authenticated `realm-<realm UUID>` broker principal,
   `RealmReceiver`, and `SocialRealm` through the `social` routing key on
   `skymist.realm.rpc.v1`. Both workers use real broker channels and callbacks.
2. Each client subscribes to friends and own-game presence. The direct sessions
   select their game account through the production Redis `WATCH/EXEC` helper.
3. Alice invites Bob; Bob accepts. Bob invites Cara; Cara accepts. The fixture
   checks both participants' callbacks and fresh friends-list RPC responses.
4. Bob publishes an authenticated active character. Alice receives the presence
   callback and queries its lossless character GUID through the service.
5. Each pair exchanges whispers in both directions. Checks cover sender parent,
   selected game account, recipient parent, text, and global listener object.
   Production shared rate-limit transactions run against real Redis.
6. The receivers and Runtime stop while client queues, leases and SQL rows remain.
   A graph producer commits a friend-note mutation during dispatcher downtime.
   New receiver/Runtime instances recover the pending outbox and the existing
   subscription IDs without another client Subscribe. A further whisper succeeds.
7. Advancing Bob's lease generation rejects both a presence publication and a
   social RPC from the old generation and retires its subscriptions.

Every world request carries the string `social_route_epoch` AMQP header required
by `SocialRealm`. SQL uses the actual Account, GameAccount, privilege and process
owner models for its baseline; social tables are created by the checked-in
`20261112000001` through `20261112000007` migrations in order. Social tables are
not generated with `sync()`. Each run prints the exact applied migration list.

Only operator realm-directory discovery and authenticated session establishment
are fixture setup: directory rows are supplied in memory and current leases are
seeded in Redis. Account checks, process ownership, auth proof, session generation,
subscriptions, graph mutations, outbox recovery, presence and whispers use the
production implementations. This does not exercise login, ticket issuance,
Sentinel failover, broker failover, all social topologies, legacy conversations,
the full SocialServer lifecycle, or native clients.

## Isolation and cleanup

Each invocation generates one `social_integration_<run>` SQL database, two
`social-test-<run>-{client,realm}` vhosts, a random worker principal and a random
realm principal. The worker's broad permissions apply only to those vhosts;
the realm principal can configure/read only its own reply queues and publish
only to the realm RPC exchange. This is transport integration, not acceptance
of the operator's production worker ACLs.

Redis session, character and rate keys use random IDs belonging to the invocation.
Service registration metadata is placed under `/social-integration/<run>/metadata`
so it cannot replace another worker's registration. The adapter retains real
Redis commands and creates an exclusive connection per watched transaction.

RPCs, publisher confirmations and cleanup actions have five-second deadlines;
callback/reconciliation polling has a ten-second deadline. SQL has a three-second
connect timeout and a bounded three-connection pool. No automatic RPC retries
can duplicate whispers or conceal uncertain mutations.

Success and assertion failures both drain workers and remove owned vhosts,
principals, SQL database and enumerated Redis keys. Cleanup errors cause failure
and preserve the original scenario error. SIGKILL or a dead dependency may leave
resources behind: the first output line records the run ID, database, vhosts,
account/game IDs, realm UUIDs and connection UUIDs for targeted inspection.
Never clean another run with wildcard database/vhost deletion or Redis flushing.

Host, Minikube fixture, deployed-service and native-client acceptance are distinct
validation boundaries; the completed checks are recorded below.

## Recorded validation, 2026-11-12

All runs below applied migrations 01–07 and passed the six reported scenario
groups: direct/world subscriptions, bilateral friendships, character presence,
both-way whispers, Runtime restart with persisted subscriptions/outbox, and
stale-generation rejection/cleanup. The three-client flow is described above.

| Environment | Run ID | Result and evidence |
| --- | --- | --- |
| Initial serial host run, loopback ports 33317–33320 | `7b7c127e6f21` | All scenarios passed. Independent read-only checks confirmed removal of the database, tracked Redis keys, both vhosts and both broker principals. |
| Main's serial host rerun, same ports | `6161858923b6` | All scenarios passed; cleanup completed; no reconciliation warnings. [Host log](../../.validation/social/integration-host.log). |
| Minikube Job, real SQL/Redis/RabbitMQ inside the Pod | `4091bbc4750c` | All scenarios passed; harness cleanup completed. [Integration log](../../.validation/social/minikube/integration.log), [Job result](../../.validation/social/minikube/job-result.json). |

The Minikube Job `bgs-social-validation/social-integration` completed with one
succeeded Pod at `2026-11-12T12:03:59Z`. Its integration container ran
`node scripts/social-integration.js` from `bgs:social-validation-final`; the
corresponding built image ID is
`sha256:3e7a0e2278e6459103c2360ac4b59a4058d47ae7f42fd6b1c465ffd60a2a15e1`
([image build log](../../.validation/social/image-build.log)). The
[Job manifest](../../.validation/social/minikube/integration.yaml) uses
`mariadb:11.4.10`, `redis:8.2-alpine` and `rabbitmq:4.3.6-management` sidecars,
loopback ports 33317–33320, and disposable `emptyDir` storage. The
[source manifest](../../.validation/social/bgs-source-manifest.json) records the
frozen source hashes. This documentation update does not change that source or
the harness/image behavior.

The initial host run emitted one `Social reconciliation deferred` warning; the
Minikube run emitted two during the invitation stage. Reconciliation subsequently
completed, and every callback assertion and outbox-drain check passed. The logs
do not include the underlying exception, so transaction contention is not a
confirmed cause.

Offline fixture checks and full BGS ESLint passed before the image build.
Minikube acceptance here covers the packaged harness and real dependencies in a
single isolated Pod. It does not establish a Helm release rollout, production
operator ACLs/discovery, service networking between Pods, readiness/recovery of
the full SocialServer deployment, Sentinel/broker failover, or production load.
Session establishment and realm discovery remain the controlled fixtures
described above. Native 15595/26972 clients were **not exercised**; native UI,
DLL/Windows behavior and gameplay acceptance remain untested by these runs.

The script itself launches no containers, builds or Kubernetes jobs; Main
provisioned the host fixtures and the Minikube Job separately. Harness resource
cleanup does not assert deletion of the Job, namespace or external fixture
containers. Evidence links refer to the sibling workspace's `.validation/`
artifacts, which are separate from this repository's tracked source.
