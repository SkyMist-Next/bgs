'use strict';
const crypto = require('node:crypto');
const { wireProof, sameProof } = require('../utils/authenticator');
const { id, Failure } = require('./contract');
const { JOIN_TICKET_SECONDS, realmPrefix, ticketKey, leaseKey, owner, sameClaimant } = require('./sessions');
const { realmAccountName, parseRealmAccountName } = require('../utils/wow-license');
const { canonicalIP } = require('../utils/admin-state');

function pendingKey(uid, name) {
    parseRealmAccountName(name);
    return realmPrefix(uid) + 'pending-15595/' + name;
}
function validateTicket(record) {
    try {
        wireProof(record);
        id(record.game_account_id); id(record.account_id); realmPrefix(record.realm_uid);
        if (record.version !== 1 || record.auth_protocol !== 'wow-15595-v0' || record.build !== 15595 || record.expansion !== 3 ||
            !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(record.namespace) || record.namespace.length > 63 ||
            record.realm_account_name !== realmAccountName(record.account_id, record.wow_license_index) ||
            !/^[a-f0-9]{80}$/.test(record.realm_key) || Object.hasOwn(record, 'client_secret') || Object.hasOwn(record, 'join_secret') ||
            !Number.isSafeInteger(record.issued_at_ms) || record.issued_at_ms < 0 ||
            record.expires_at_ms !== record.issued_at_ms + JOIN_TICKET_SECONDS * 1000 || !Number.isSafeInteger(record.expires_at_ms) ||
            !Number.isInteger(record.region) || record.region < 1 || record.region > 255 ||
            !Number.isInteger(record.gm_level) || record.gm_level < 0 || record.gm_level > 255 ||
            typeof record.locale !== 'string' || !/^[a-z]{2}[A-Z]{2}$/.test(record.locale) ||
            typeof record.platform !== 'string' || !/^[A-Za-z0-9]{1,4}$/.test(record.platform) ||
            canonicalIP(record.address) !== record.address) { throw new Error(); }
    } catch { throw new Failure('INVALID_15595_TICKET'); }
    return record;
}
function worldProof(name, key, clientSeed, serverSeed) {
    parseRealmAccountName(name);
    if (!Buffer.isBuffer(key) || key.length !== 40 || ![clientSeed, serverSeed].every(n => Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF)) {
        throw new Failure('INVALID_15595_PROOF');
    }
    const seeds = Buffer.alloc(12);
    seeds.writeUInt32LE(clientSeed, 4); seeds.writeUInt32LE(serverSeed, 8);
    return crypto.createHash('sha1').update(name, 'ascii').update(seeds).update(key).digest();
}
class CataclysmSessions {
    constructor(store, clock = Date.now) { this.store = store; this.clock = clock; }
    async issue(ticket, record) {
        validateTicket(record);
        const path = ticketKey(record.realm_uid, ticket), pending = pendingKey(record.realm_uid, record.realm_account_name);
        for (let retry = 0; retry < 8; retry++) {
            const old = await this.store.run(client => client.get(pending));
            const previous = old ? ticketKey(record.realm_uid, old) : null;
            try {
                return await this.store.transaction([path, pending, ...(previous ? [previous] : [])], async client => {
                    if (await client.get(pending) !== old) { throw new Failure('PENDING_CHANGED'); }
                    if (await client.get(path) !== null) { throw new Failure('TICKET_COLLISION'); }
                    // Reading the old ticket under WATCH also protects replacement against
                    // another issuer or claimant. Never delete a newly observed ticket.
                    if (previous) { await client.get(previous); }
                    if (record.expires_at_ms <= this.clock() || record.issued_at_ms > this.clock()) { throw new Failure('TICKET_EXPIRED'); }
                    return { commands: [
                        ['SET', path, JSON.stringify(record), 'PXAT', String(record.expires_at_ms)],
                        ['SET', pending, ticket, 'PXAT', String(record.expires_at_ms)],
                        ...(previous ? [['DEL', previous]] : [])
                    ], result: record };
                });
            } catch (error) { if (error.code !== 'PENDING_CHANGED') { throw error; } }
        }
        throw new Failure('PENDING_BUSY', true);
    }
    async claim(ticket, observed, proposed, proof, clientSeed, serverSeed) {
        owner(proposed);
        const record = validateTicket(JSON.parse(observed));
        const expected = worldProof(record.realm_account_name, Buffer.from(record.realm_key, 'hex'), clientSeed, serverSeed);
        if (!Buffer.isBuffer(proof) || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) { throw new Failure('INVALID_15595_PROOF'); }
        if (!['namespace', 'realm_uid', 'game_account_id', 'account_id', 'expansion', 'build'].every(key => record[key] === proposed[key]) || proposed.generation !== '0' || !sameProof(record, proposed)) {
            throw new Failure('TICKET_IDENTITY_MISMATCH');
        }
        const path = ticketKey(proposed.realm_uid, ticket), pending = pendingKey(proposed.realm_uid, record.realm_account_name), lease = leaseKey(proposed.game_account_id);
        return this.store.transaction([pending, path, lease], async client => {
            const existing = await client.get(lease);
            if (existing) {
                const active = owner(JSON.parse(existing));
                if (!sameClaimant(active, proposed)) { throw new Failure('SESSION_ALREADY_ACTIVE'); }
                return { commands: [], result: active };
            }
            if (record.expires_at_ms <= this.clock() || record.issued_at_ms > this.clock()) { throw new Failure('TICKET_EXPIRED'); }
            if (await client.get(pending) !== ticket || await client.get(path) !== observed) { throw new Failure('TICKET_UNAVAILABLE'); }
            return { commands: [['SET', lease, JSON.stringify(proposed), 'EX', '90'], ['DEL', pending], ['DEL', path]], result: proposed };
        });
    }
}
module.exports = { CataclysmSessions, pendingKey, validateTicket, worldProof };
