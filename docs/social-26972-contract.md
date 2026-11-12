# Social contract: WoW 7.3.5.26972

The authority for the stock player protocol is the x64 26972 client, not the
18179 BSN service guides. The compatibility DLL translates this contract into
15595 native ABI records and callbacks. Legacy groups are a separate,
versioned `skymist.protocol.legacy_chat.v1` extension; stock Legion never receives it.

## Artifact and evidence

Read-only REA/IDA analysis used
`~/work/re/WoW/artifacts/clients/7.3.5.26972/analysis-x64/Wow-64.analysis.exe`,
SHA-256 `6aa038904f19965040b75e843a16cf2cb3310caa0b9391aec498e7a985d2c852`.
This is the decrypted analysis image, not the original encrypted executable.
The preserved `~/Games/wow-7.3.5/Wow-64.exe` has SHA-256
`6853f5ee922a3315552e15c7b46fc711927dc9f35513adc01be1aaf8c3588ad7`.
Selected [REA evidence identities](evidence/social-26972.json) record the provider,
artifact and operations. Detailed local evidence is under the workspace's
`.validation/social/`. Native declarations/UI consumption in
`~/work/dev/wow/wowdecomp15595/WoW/Source/Ui/` are the 15595 adapter reference.

These are static observations. They do not establish native-client acceptance,
retail server policy, live notification ordering or outage behavior.

## Service routing and friendships

The world packet uses the FNV hash of the fully qualified protobuf service;
the BGS socket uses the descriptor's historical service name. They are distinct.
Friends world hash is `ABDFED63`, Presence `D8F94B3B`, UserManager `8EE5694E`.
The descriptors recovered from this exact build remain in `proto/bgs/low/pb/client`.

The native invite path `140A55E80 -> 140C124B0 -> 140D14510 -> 140D33220 ->
140D33570` selects email or BattleTag and resolves role IDs through the advertised
role names at `140D2F9E0`. The literal names are `battle_tag_friend` and
`real_id_friend`. Server IDs 1 and 2 are our advertised allocation, not claimed
retail constants. Direct parent-ID invites use Real ID. The friend-note path
`140A558C0 -> 140C125D0 -> 140D1E000 -> 140D33670` sends an attribute named
`friend_note` containing a string variant.

Real names require an accepted Real ID edge and both profiles' opt-in. BattleTag,
pending invites, blocks and co-group membership never grant Real ID visibility.
Presence withdrawals clear already cached names after visibility changes.

## Whispers

`140A56700 -> 140C1B290 -> 140D1DDA0 -> 140D3D4F0 -> 140D3D330` sends a
`Notification` directly through `NotificationService.SendNotification` (method 1,
world hash `53C8C253`). It is not a Channel.SendMessage call.

| Notification field | Observed meaning |
| --- | --- |
| sender_id | Selected game-account EntityId |
| target_id | System entity: high `2 << 56`, low 0 |
| type | `WHISPER` |
| attribute | One `whisper` attribute with string_value |
| sender_account_id | Parent sender EntityId |
| target_account_id | Parent recipient EntityId |

The receive registration at `140D3B930` resolves `NotificationListener` world hash
`C1490E58`, method 1. `140D3BEB0 -> 140D3CC60` consumes the parent, game account and
text. The request completion reports sent/failure from the RPC status; uncertain
sends must not be retried automatically. Native message storage bounds text to
1020 bytes. The backend applies a shared 10-per-10-second rate limit.

The method high bit `80000000` is required on the world notification wire.
The packet constructor `14050DEA0` calls `140503D00`, which reads Type as a raw
uint64. Handler `140D43B20` passes it unchanged to `1411FE870`; that dispatcher
compares the complete value with the registration key `C1490E5880000001`.
The world bridge adds this bit only when serializing SMSG_BATTLENET_NOTIFICATION;
BGS service method IDs remain ordinary method numbers. Global notification
objects use object ID 0. Live behavior still requires native validation.
The missing notification-service descriptor was
reconstructed from these calls; historical socket descriptor names are the
compatibility service allocation, while the world hashes are observed.

## Session recovery and bounds

The native session-state packet constructor `14050D4B0` reads the state into
offset 0x20. Its registered handler `140D442A0` tests state == 1 and calls
`140D44910`. False clears and recreates Friends, Presence and Notification SDK
objects through `140D443A0`, then emits the destroyed signal; true emits the
established signal. This supplies the native cache-reset path for a recovered
world social connection without closing the gameplay socket. Static decoding
evidence does not establish runtime reconnect acceptance.

Every trusted social request carries a canonical nonzero uint64 AMQP header
`social_route_epoch`. A replacement exclusive reply queue advances that epoch.
SQL retains its fence even with zero subscriptions; delayed requests cannot
restore a previous queue. The existing session and realm-process fences still
apply. Requests and individual notifications are limited to 64 KiB decoded;
full subscription replies allow 1 MiB to hold the bounded friend graph and notes.
The 15595 ABI has fixed 100-entry block arrays, so the shared effective parent
block union is capped at 100; license fanout does not consume native block rows.

## Presence

Presence subscriptions receive ChannelListener OnJoin (method 1), then
OnUpdateChannelState (method 6), using the requested object ID. The channel state
contains extension 101, `bgs.protocol.presence.v1.ChannelState.presence`, with
entity_id and SET/CLEAR field operations. `140D37AA0`, `140D391E0`, `140D39250`
and `140D39CE0` establish this path.

All supported keys have unique_id 0 except repeated account game IDs. Their
unique IDs are stable full game-account IDs. `BN` program is 16974; `WoW` is
5730135. Timestamps below are signed int64 microseconds since Unix epoch.

| Program/group/field | Variant | Meaning | Native getter |
| --- | --- | --- | --- |
| BN/1/1 | string | Real/display name, subject to privacy | 140D354A0 |
| BN/1/2 | string | Broadcast | 140D35160 |
| BN/1/3 | entity_id | Repeated online game accounts | 140D35560 |
| BN/1/4 | string | BattleTag | 140D35080 |
| BN/1/5 | int64 | Broadcast timestamp | 140D351D0 |
| BN/1/6 | int64 | Last online timestamp | 140D356A0 |
| BN/1/7 | bool | AFK | 140D34F50 |
| BN/1/11 | bool | DND | 140D35230 |
| BN/2/1 | bool | Game account online | 140D35700 |
| BN/2/2 | int64 | DND, nonzero means true | 140D350F0 |
| BN/2/7 | entity_id | Parent account | 140D35000 |
| BN/2/10 | bool | Game account AFK | 140D34FB0 |

`140BAA430` and `140A581D0` connect account getters to the Lua tuple. Group 2
field 1000 is a locally derived rich-presence string, not a backend-owned field.

`140D358E0` reads the following WoW group 2 values; `140A57CE0` consumes them in
the game-account Lua tuple. Realm, race, class and zone names are resolved through
native caches. `14049AF90` identifies the realm-address cache; `1408958E0` reads
faction bits. The core's TeamID 0/1/2 is translated to Alliance/Horde/Neutral
mask 2/4/1; neutral characters are never presented as Horde.

| WoW/2 field | Variant | Meaning |
| --- | --- | --- |
| 1 | uint64 | Realm address |
| 2 | uint64 | Race ID |
| 3 | uint64 | Class ID |
| 5 | uint64 | Level |
| 6 | uint64 | Zone ID |
| 7 | int64 | Faction bit mask |
| 10 | string | Active character name |
| 11 | uint64 | Realm ID (low 16 bits of realm address) |
| 12 | uint64 | Player GUID low 64 bits |

Fields 8 and 9 are not populated: the publisher does not supply their data.
The native reader uses field 9 for gender-dependent names. The wire GUID field
is explicitly uint64: native code reconstructs the player GUID from fields 11
and 12. The authenticated internal publication retains the complete decimal
128-bit GUID. Persistent parent/game IDs are never truncated into native handles.

Only the authenticated realm publisher owns active characters. Its session,
generation and process fence must still match the current gameplay lease.
Character withdrawal retains a sequence tombstone. No offline toon directory is
created. Client writes are restricted to broadcast and AFK/DND state; identity,
online status and character metadata are server-owned.
