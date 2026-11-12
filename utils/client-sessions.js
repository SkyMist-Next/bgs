'use strict';
const { blocked, checkIP } = require('./admin-state');
const { requireProof } = require('./authenticator');

// A client session is the authenticated identity of one BGS client connection:
// account, peer address, authentication proof, client build and at most one
// selected game account. It slides five minutes past its last use.
const PREFIX = '/aurora/connections/';
const TTL_SECONDS = 300;
// Each client build may only use game accounts of its own expansion.
const BUILD_EXPANSION = Object.freeze({ 15595: 3, 26972: 6 });
const MAX_ID = 9223372036854775807n;

// includeBlocked judges only the license, for callers that report ban state.
function eligibleGame(game, build, { includeBlocked = false } = {}) {
    if (!game || (!includeBlocked && blocked(game))) { return false; }
    const expansion = BUILD_EXPANSION[build];
    return expansion === undefined || (game.program === 'WoW' && Number(game.expansion) === expansion);
}
function key(connectionId) {
    if (typeof connectionId !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(connectionId)) { throw 0xA; }
    return PREFIX + connectionId;
}
function gameId(value) {
    if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > MAX_ID) { throw 0xA; }
    return String(value);
}

class ClientSessions {
    constructor(store, models) { this.store = store; this.models = models; }

    open(identity, { accountId, proof, applicationVersion }) {
        const value = { accountId: String(accountId), address: identity.address, ...proof, ...(applicationVersion ? { applicationVersion } : {}) };
        return this.store.run(client => client.set(key(identity.connectionId), JSON.stringify(value), { EX: TTL_SECONDS }));
    }
    // The calling connection's session, refreshing its expiry. Any failure to
    // authenticate is 0xA; dependency failures propagate.
    async resolve(context) {
        const supplied = context?.identity;
        if (!supplied?.connectionId || !supplied.address) { throw 0xA; }
        const raw = await this.store.run(client => client.getEx(key(supplied.connectionId), { EX: TTL_SECONDS }));
        const value = raw ? JSON.parse(raw) : null;
        if (!value || value.address !== supplied.address || !await this.valid(value)) { throw 0xA; }
        return { ...value, connectionId: supplied.connectionId };
    }
    // A session still held by the expected account and address, without refreshing
    // it. Revocation is null; dependency failures propagate so callers can retain state.
    async current(connectionId, { accountId, address }, transaction) {
        const raw = await this.store.run(client => client.get(key(connectionId)));
        const value = raw ? JSON.parse(raw) : null;
        if (!value || value.accountId !== accountId || value.address !== address || !await this.valid(value, transaction)) { return null; }
        return { ...value, connectionId };
    }
    async ownedGame(session, id, { includeBlocked = false } = {}) {
        const game = await this.models.GameAccount.findByPk(gameId(id));
        if (!game || String(game.accountId) !== session.accountId || !eligibleGame(game, session.applicationVersion, { includeBlocked })) { throw 0xA; }
        return game;
    }
    // Binds one game account to the session for its remaining lifetime; a session
    // never changes its selected game account.
    async selectGame(session, id) {
        const selected = gameId(id);
        if (session.gameAccountId && session.gameAccountId !== selected) { throw 0xA; }
        await this.ownedGame(session, selected);
        const account = await this.models.Account.findByPk(session.accountId);
        if (blocked(account)) { throw 0xA; }
        const path = key(session.connectionId);
        await this.store.transaction([path], async client => {
            const raw = await client.get(path);
            if (!raw || await client.pTTL(path) <= 0) { throw 0xA; }
            const actual = JSON.parse(raw);
            if (actual.accountId !== session.accountId || actual.address !== session.address ||
                (actual.gameAccountId && actual.gameAccountId !== selected)) { throw 0xA; }
            try { requireProof(account, actual); } catch { throw 0xA; }
            return { commands: actual.gameAccountId === selected ? [] : [
                ['SET', path, JSON.stringify({ ...actual, gameAccountId: selected }), 'XX', 'KEEPTTL']
            ] };
        });
        return { ...session, gameAccountId: selected };
    }
    touch(connectionId) { return this.store.run(client => client.getEx(key(connectionId), { EX: TTL_SECONDS })); }
    end(connectionId) { return this.store.run(client => client.del(key(connectionId))); }

    async valid(value, transaction) {
        try { await checkIP(this.models, value.address, Date.now(), { transaction }); }
        catch (error) { if (error === 0xA) { return false; } throw error; }
        const account = await this.models.Account.findByPk(value.accountId, { transaction });
        if (blocked(account)) { return false; }
        try { requireProof(account, value); } catch { return false; }
        return true;
    }
}
module.exports = { ClientSessions, eligibleGame };
