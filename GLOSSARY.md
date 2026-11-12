# Battle.net social domain

Social relationships belong to Battle.net accounts and span the licenses, builds, realms and regions of one installation.

**Battle.net account** — The parent identity that owns friendships, invitations, notes, blocks and a profile.

**Game account** — A separately selectable game license owned by a Battle.net account. Concurrent licenses remain distinct online participants.

**Real ID friendship** — An accepted friendship that permits sharing real names while both accounts have opted into Real ID.

**BattleTag friendship** — An accepted friendship identified by full BattleTags. It does not permit access to real names.

**Active character** — The character currently played by a game account in an authenticated world session.

**Presence** — The current availability and activity of an account or game account, including its active character when one exists.

**Whisper** — A private live message between Battle.net accounts.

**Legacy conversation** — A live group available to 15595 clients, whose participants are selected game accounts. It is not a Legion group feature.

**Social session** — An authenticated Battle.net session whose subscriptions and legacy conversation membership can recover after a temporary social outage. Logout or expiry ends it.

**World session lease** — The exclusive, expiring claim a realm process holds on one game account's authenticated world session. Its world identity is the session incarnation (session, generation and realm process). It fences gameplay and social publication; a malformed lease is never live.

**Client session** — The authenticated identity of one BGS client connection: Battle.net account, peer address, authentication proof, client build and at most one selected game account. It expires five minutes after last use. Its build decides which game accounts are eligible: 15595 uses Cataclysm licenses and 26972 uses Legion licenses.

**Realm-list ticket** — A five-minute ticket that binds one client session and game account to a realm-list view and that build's join rules.

**Realm join ticket** — The 60-second ticket that the realm process claims to open a world session lease.
