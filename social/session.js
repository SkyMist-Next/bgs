'use strict';

// The social participation of one client session or one world session (see
// GLOSSARY.md). Adapters receive one per RPC from SocialRuntime.session(context);
// the runtime also rebuilds one, without a request, for each stored subscription
// it reconciles. Data fields are the authenticated owner: accountId,
// gameAccountId, sessionKey, route, applicationVersion and the proof/world fields.
class SocialSession {
    #runtime;
    #context;

    constructor(runtime, data, context = null) {
        Object.assign(this, data);
        this.#runtime = runtime;
        this.#context = context;
    }

    // Binds one game account to this session; a session never changes its selection.
    async selectGame(gameAccountId) {
        await this.#runtime.selectGame(this, gameAccountId);
        return this;
    }
    // The selected license, still owned, eligible for this build and not banned.
    async selectedGame() {
        if (!this.gameAccountId) { throw 0xA; }
        return this.#runtime.sessions.ownedGame(this, this.gameAccountId);
    }
    // Subscriptions become ready only after this request's reply is published.
    async subscribe(kind, target, objectId, filter = {}, snapshot = null) {
        return this.#runtime.subscribe(this.#request(), this, kind, target, objectId, filter, snapshot);
    }
    unsubscribe(kind, target, objectId) { return this.#runtime.unsubscribe(this, kind, target, objectId); }
    // A session block lasts only as long as this session; true when newly added.
    blockForSession(accountId) { return this.#runtime.blockSession(this, accountId); }
    unblockForSession(accountId) { return this.#runtime.unblockSession(this, accountId); }
    sessionBlocks() { return this.#runtime.sessionBlocks(this); }
    // The idempotency key of the current RPC within this session.
    operationId() { return this.#runtime.operationId(this.#request()); }

    #request() {
        if (!this.#context) { throw 0xA; }
        return this.#context;
    }
}
module.exports = { SocialSession };
