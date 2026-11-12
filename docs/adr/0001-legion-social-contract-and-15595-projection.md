# Use Legion social semantics with a 15595 presentation adapter

## Context

The compatibility DLL exposes the older 15595 social interface, while the shared installation also serves Legion 26972. The older interface distinguishes toons and uses Real ID terminology; Legion uses account and game-account presence and no longer provides legacy conversations.

## Decision

Use the actual 26972 client as the authority for player-facing social protocols and behavior. Recover missing contracts from that artifact before implementing them. Keep Real ID and BattleTag relationship roles distinct in shared BGS, and project BattleTags into the existing 15595 name fields without disclosing real names. Toon getters project game-account presence and active characters, without an offline character directory. Real ID profiles are administered privately and default to disabled.

Legacy conversations are an explicitly versioned, 15595-only extension. Membership belongs to the selected game account; only accepted friends of the inviter may be admitted, subject to blocks, twelve members and six slots per session. Membership survives character changes and temporary social outages, ends on leave, logout or session expiry, and converts to whispers when two remain. Messages are live-only, with no history, offline queue or automatic retry of uncertain sends.

## Why

A shared account graph allows native clients of both builds to exchange friendships, presence and whispers. The DLL projection retains the existing 15595 UI without an addon or new executable patch, while keeping the agreed legacy group behavior separate from the stock Legion contract. Social recovery must not interrupt otherwise healthy gameplay.
