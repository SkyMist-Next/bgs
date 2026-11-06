# Cataclysm 15595 compatibility

Build 15595 authenticates through BGS with an expansion-3 WoW license. Legion
26972 keeps its expansion-6 `Command_RealmJoinRequest_v1_b9` response. Cataclysm
uses `Command_RealmJoinRequest_v0_b9`; unsupported versions, mixed commands,
duplicate parameters, invalid variant types, and cross-build joins are rejected.
Realm-list discovery and ticket requests retain their v1 names.

Apply `20261105000000-wow-license-identity.js` before updating BGS/admin writers.
The migration adds an account-level high-water counter and a unique persisted
WoW license index, backfills existing WoW licenses in ascending numeric game
account ID order under each locked parent, and preserves prior allocations on
retry. Positive indexes are shared across regions and expansions. Creation locks
and increments the parent in the same transaction as insertion. Deleted indexes
are never reused; parent, program, and index are immutable. SQL triggers reject
old writers that omit an index, identity changes, and counter decrements. Direct
bulk provisioning must use this allocation contract; ORM WoW creates require a
transaction and bulk creation requires individual hooks. Migration rollback is
intentionally unsupported because issued native identities cannot be renumbered.

The canonical native alias is `<decimal account ID>#<persisted license index>`.
It is emitted in `GetGameAccountState.state.game_level_info.name` and the v0 join
response's `Param_RealmAccountName`. The selected game account ID remains an
independent trusted identity. `GameStatus` has no display-name protobuf field;
the compatibility client can use `WoW<index> [ID]` as its UI fallback. No protobuf
field has been added, and Legion display-name behavior is unchanged.

The v0 response contains `Param_RealmSessionKey` as exactly 40 raw bytes and a
20-byte `Param_RealmJoinTicket`; it has no `Param_JoinSecret`. Its trusted Redis
record has `auth_protocol: wow-15595-v0`, `realm_account_name`, `wow_license_index`,
`realm_key` as 80 lowercase hex digits, explicit parent/game identities, and
`issued_at_ms`/`expires_at_ms` separated by 60000 ms. Ticket and alias index use the
same absolute Redis expiration. The index key is
`/skymist/v1/realms/<realm UID>/pending-15595/<canonical alias>`.

Issuance atomically replaces the previous alias ticket. Claim verifies the SHA1
world proof before mutation, then atomically compares the exact observed ticket,
alias index and lease using WATCH/MULTI/EXEC. Wrong proofs never consume tickets.
A conflicting owner cannot claim an existing lease; the exact owner may recover
a lost acknowledgement without extending the lease or losing its generation.
Legacy Legion consumers explicitly reject v0 records. World admission must also
check current BGS policy, including the persisted index, before accepting a player.

Validation:

- `npm test` and `npm run lint` cover both protocol paths, persisted identity,
  malformed dispatch, proof failures, collisions, supersession, and replay.
- `CATACLYSM_TEST=1 CATACLYSM_TEST_DB_PORT=<isolated MariaDB port>
  CATACLYSM_TEST_REDIS_PORT=<isolated Redis port> node scripts/cataclysm-integration.js`
  creates a random database and scoped Redis keys, exercising real migration,
  trigger, concurrent allocation and atomic claim behavior. The script requires
  the documented local fixture credentials in its source; do not target shared
  services.
- The workspace `.validation/cataclysm-15595` harness separately exercises the
  deployed Minikube BGS/operator/world path using synthetic clients. Windows DLL
  and retail client acceptance remain a separate gate.
