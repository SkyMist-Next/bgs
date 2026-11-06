'use strict';
const { id, Failure } = require('./contract');
const { canonicalIP } = require('../utils/admin-state');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OWNER_FIELDS = ['namespace', 'realm_uid', 'pod_uid', 'instance_id', 'game_account_id', 'account_id', 'session_id', 'build', 'expansion', 'address'];
function sameOwner(actual, expected) { return OWNER_FIELDS.every(key => actual[key] === expected[key]); }
function requireOwner(raw, expected) {
    if (!raw) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
    const actual = owner(JSON.parse(raw));
    if (!sameOwner(actual, expected)) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
    return actual;
}
function realmPrefix(uid) {
    if (!UUID.test(uid)) { throw new Failure('INVALID_REALM'); }
    return '/skymist/v1/realms/' + uid + '/';
}
function ticketKey(uid, ticket) {
    if (!/^[a-f0-9]{40}$/.test(ticket)) { throw new Failure('INVALID_TICKET'); }
    return realmPrefix(uid) + 'tickets/' + ticket;
}
function leaseKey(account) { return '/skymist/v1/sessions/' + id(account); }
function owner(record) {
    if (!record || record.version !== 1 || !['realm_uid', 'pod_uid', 'instance_id', 'session_id'].every(key => UUID.test(record[key])) ||
        !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(record.namespace) || record.namespace.length > 63) { throw new Failure('INVALID_SESSION'); }
    id(record.game_account_id); id(record.account_id); id(record.generation, true);
    try { if (canonicalIP(record.address) !== record.address) { throw new Error(); } }
    catch { throw new Failure('INVALID_SESSION_ADDRESS'); }
    if (!Number.isInteger(record.build) || record.build <= 0 || !Number.isInteger(record.expansion) || record.expansion < 0 || record.expansion > 127) { throw new Failure('INVALID_SESSION'); }
    return record;
}
class Sessions {
    constructor(store) { this.store = store; }
    async issue(ticket, record) {
        if (record.version !== 1 || record.auth_protocol === 'wow-15595-v0') { throw new Failure('INVALID_TICKET'); }
        id(record.game_account_id); id(record.account_id);
        const result = await this.store.run(client => client.set(ticketKey(record.realm_uid, ticket), JSON.stringify(record), { NX: true }));
        if (result !== 'OK') { throw new Failure('TICKET_COLLISION'); }
    }
    async claim(ticket, observed, proposed) {
        owner(proposed);
        if (JSON.parse(observed).auth_protocol === 'wow-15595-v0') { throw new Failure('INVALID_TICKET'); }
        const ticketPath = ticketKey(proposed.realm_uid, ticket), leasePath = leaseKey(proposed.game_account_id);
        return this.store.transaction([ticketPath, leasePath], async client => {
            const existing = await client.get(leasePath);
            if (existing) {
                const active = owner(JSON.parse(existing));
                if (!sameOwner(active, proposed)) { throw new Failure('SESSION_ALREADY_ACTIVE'); }
                return { commands: [], result: active };
            }
            if (await client.get(ticketPath) !== observed) { throw new Failure('TICKET_UNAVAILABLE'); }
            const record = JSON.parse(observed);
            if (record.version !== 1 || proposed.generation !== '0') { throw new Failure('INVALID_RECORD'); }
            if (!['namespace', 'realm_uid', 'game_account_id', 'account_id', 'expansion', 'build'].every(key => record[key] === proposed[key])) { throw new Failure('TICKET_IDENTITY_MISMATCH'); }
            return { commands: [['SET', leasePath, JSON.stringify(proposed), 'EX', '90'], ['DEL', ticketPath]], result: proposed };
        });
    }
    async update(expected, operation, generation = '') {
        owner(expected);
        if (!['renew', 'release', 'bind'].includes(operation)) { throw new Failure('INVALID_OPERATION'); }
        if (operation === 'bind') { id(generation); }
        const key = leaseKey(expected.game_account_id);
        return this.store.transaction([key], async client => {
            const actual = requireOwner(await client.get(key), expected);
            if (operation === 'bind' && actual.generation === generation && ['0', generation].includes(expected.generation)) {
                return { commands: [], result: actual };
            }
            if (actual.generation !== expected.generation) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
            let commands;
            if (operation === 'renew') { commands = [['EXPIRE', key, '90']]; }
            else if (operation === 'release') { commands = [['DEL', key]]; }
            else {
                if (actual.generation !== '0') { throw new Failure('STALE_SESSION'); }
                actual.generation = generation;
                commands = [['SET', key, JSON.stringify(actual), 'KEEPTTL']];
            }
            return { commands, result: actual };
        });
    }
    async continuation(expected, token, operation, value) {
        owner(expected);
        if (!/^[a-f0-9]{32}$/.test(token) || !['put', 'take'].includes(operation)) { throw new Failure('INVALID_CONTINUATION'); }
        if (operation === 'put' && (!value || value.session_id !== expected.session_id || value.generation !== expected.generation ||
            !/^[a-f0-9]{80}$/.test(value.key))) { throw new Failure('INVALID_CONTINUATION'); }
        const proposed = operation === 'put' ? { session_id: expected.session_id, generation: expected.generation, key: value.key, owner: expected } : undefined;
        const leasePath = leaseKey(expected.game_account_id), key = realmPrefix(expected.realm_uid) + 'continuations/' + token;
        return this.store.transaction([leasePath, key], async client => {
            const actual = requireOwner(await client.get(leasePath), expected);
            if (actual.generation !== expected.generation) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
            if (actual.generation === '0') { throw new Failure('SESSION_NOT_OPEN'); }
            const existing = await client.get(key);
            if (operation === 'put') {
                const encoded = JSON.stringify(proposed);
                if (existing === encoded) { return { commands: [], result: proposed }; }
                if (existing) { throw new Failure('CONTINUATION_EXISTS'); }
                const expiresAt = await client.pExpireTime(leasePath);
                if (expiresAt <= 0) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
                return { commands: [['SET', key, encoded, 'PXAT', String(expiresAt)]], result: proposed };
            }
            if (!existing) { throw new Failure('CONTINUATION_UNAVAILABLE'); }
            const record = JSON.parse(existing);
            if (record.session_id !== actual.session_id || record.generation !== actual.generation) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
            if (!/^[a-f0-9]{80}$/.test(record.key)) { throw new Failure('INVALID_CONTINUATION'); }
            const recordedOwner = owner(record.owner);
            if (!sameOwner(recordedOwner, actual) || recordedOwner.generation !== actual.generation) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
            return { commands: [['DEL', key]], result: record };
        });
    }
}
module.exports = { Sessions, ticketKey, leaseKey, realmPrefix, owner };
