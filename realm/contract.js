'use strict';

const crypto = require('node:crypto');
const { canonicalIP } = require('../utils/admin-state');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DOMAINS = new Set(['mounts', 'toys', 'heirlooms', 'appearances', 'favorite_appearances',
    'achievements', 'achievement_criteria', 'pets', 'pet_slots', 'tutorials', 'characters', 'undelete']);
const LIMIT = 262144;
const MAX_CHANGES = 4096, MAX_CHUNKS = 512, MAX_RESERVATION_BYTES = 8388608;
class Failure extends Error {
    constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}
function id(value, zero = false) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n || (!zero && value === '0')) {
        throw new Failure('INVALID_ID');
    }
    return value;
}
function exact(value, keys) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) {
        throw new Failure('INVALID_FIELDS');
    }
}
function canonical(value) {
    if (Array.isArray(value)) { return '[' + value.map(canonical).join(',') + ']'; }
    if (value && typeof value === 'object') { return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'; }
    return JSON.stringify(value);
}
function stateValue(value, depth = 0) {
    if (depth > 16) { throw new Failure('STATE_TOO_DEEP'); }
    if (typeof value === 'string' && value.length > 4096) { throw new Failure('INVALID_STATE_VALUE'); }
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) { throw new Failure('INVALID_STATE_NUMBER'); }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length > (Array.isArray(value) ? 2048 : 128)) { throw new Failure('INVALID_STATE_VALUE'); }
        for (const [key, child] of entries) {
            if (key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) { throw new Failure('INVALID_STATE_KEY'); }
            stateValue(child, depth + 1);
        }
    }
}
function change(value, realmUID) {
    exact(value, ['domain', 'key', 'revision', 'value']);
    if (!DOMAINS.has(value.domain) || typeof value.key !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(value.key)) { throw new Failure('INVALID_ARGUMENTS'); }
    id(value.revision, true);
    if (value.domain === 'characters') {
        if (value.key !== realmUID) { throw new Failure('INVALID_CHARACTER_REALM'); }
        exact(value.value, ['count', 'last_character']);
        if (!Number.isInteger(value.value.count) || value.value.count < 0 || value.value.count > 255) { throw new Failure('INVALID_ARGUMENTS'); }
        if (value.value.last_character !== null) { id(value.value.last_character); }
    }
    if (value.domain === 'undelete') {
        id(value.key);
        exact(value.value, ['cooldown', 'token']);
        if (!Number.isInteger(value.value.cooldown) || value.value.cooldown < 0 || value.value.cooldown > 4294967295 || !UUID.test(value.value.token)) {
            throw new Failure('INVALID_ARGUMENTS');
        }
    }
    stateValue(value.value);
    if (Buffer.byteLength(JSON.stringify(value.value)) > 16384) { throw new Failure('STATE_TOO_LARGE'); }
}
function validate(body, properties, now = Date.now()) {
    if (!Buffer.isBuffer(body) || body.length > LIMIT || properties.contentType !== 'application/json') { throw new Failure('INVALID_MESSAGE'); }
    let request;
    try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw new Failure('INVALID_JSON'); }
    exact(request, ['version', 'request_id', 'operation', 'deadline', 'realm', 'game_account_id', 'session_id', 'generation', 'arguments']);
    if (request.version !== 1 || !UUID.test(request.request_id) || request.request_id !== properties.correlationId) { throw new Failure('INVALID_REQUEST'); }
    exact(request.realm, ['namespace', 'realm_uid', 'pod_uid', 'instance_id']);
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(request.realm.namespace) || request.realm.namespace.length > 63 ||
        !['realm_uid', 'pod_uid', 'instance_id'].every(k => UUID.test(request.realm[k])) || !UUID.test(request.session_id)) { throw new Failure('INVALID_IDENTITY'); }
    if (properties.userId !== 'realm-' + request.realm.realm_uid ||
        !new RegExp('^realm\\.reply\\.' + request.realm.realm_uid + '\\.[a-f0-9-]{36}$').test(properties.replyTo || '')) { throw new Failure('UNAUTHORIZED_CALLER'); }
    id(request.game_account_id, ['realm.probe', 'realm.catalog', 'state.pending', 'process.claim', 'process.check'].includes(request.operation)); id(request.generation, true);
    if (typeof request.deadline !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(request.deadline) || !Number.isFinite(Date.parse(request.deadline))) { throw new Failure('INVALID_DEADLINE'); }
    if (Date.parse(request.deadline) > now + 300000) { throw new Failure('DEADLINE_TOO_DISTANT'); }
    const args = request.arguments;
    switch (request.operation) {
    case 'social.presence':
        require('../social/realm-contract').validatePresence(args);
        break;
    case 'social.call':
        require('../social/realm-contract').validateCall(args);
        break;
    case 'process.claim': case 'process.check':
        exact(args, request.operation === 'process.claim' ? ['revision', 'build', 'expansion', 'previous_epoch', 'epoch'] : ['revision', 'build', 'expansion', 'epoch']);
        if (request.game_account_id !== '0' || request.generation !== '0' || typeof args.revision !== 'string' || !/^[a-f0-9]{64}$/.test(args.revision) ||
            !Number.isInteger(args.build) || args.build < 1 || args.build > 4294967295 || !Number.isInteger(args.expansion) || args.expansion < 0 || args.expansion > 127 || !UUID.test(args.epoch) ||
            (request.operation === 'process.claim' && args.previous_epoch !== '' && !UUID.test(args.previous_epoch))) { throw new Failure('INVALID_ARGUMENTS'); }
        break;
    case 'realm.probe':
        exact(args, []);
        if (request.game_account_id !== '0' || request.generation !== '0') { throw new Failure('INVALID_ARGUMENTS'); }
        break;
    case 'state.pending': case 'realm.catalog':
        exact(args, ['after', 'limit']);
        if (request.game_account_id !== '0' || request.generation !== '0' || (args.after !== '' && !UUID.test(args.after)) ||
            !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) { throw new Failure('INVALID_ARGUMENTS'); }
        break;
    case 'session.open': exact(args, []); if (request.generation !== '0') { throw new Failure('INVALID_GENERATION'); } break;
    case 'account.policy':
        exact(args, ['address']);
        try { if (canonicalIP(args.address) !== args.address) { throw new Error(); } }
        catch { throw new Failure('INVALID_PEER_ADDRESS'); }
        break;
    case 'account.restore-policy': exact(args, []); break;
    case 'client.join':
        exact(args, ['realm_address', 'client_secret', 'locale', 'platform', 'peer']);
        if (!Number.isInteger(args.realm_address) || args.realm_address < 1 || args.realm_address > 4294967295 ||
            typeof args.client_secret !== 'string' || !/^[a-f0-9]{64}$/.test(args.client_secret) ||
            typeof args.locale !== 'string' || !/^[a-z]{2}[A-Z]{2}$/.test(args.locale) ||
            typeof args.platform !== 'string' || !/^[A-Za-z0-9]{1,4}$/.test(args.platform)) { throw new Failure('INVALID_ARGUMENTS'); }
        try { if (canonicalIP(args.peer) !== args.peer) { throw new Error(); } }
        catch { throw new Failure('INVALID_PEER_ADDRESS'); }
        break;
    case 'state.read':
        exact(args, ['domain', 'after', 'limit']);
        if (!DOMAINS.has(args.domain) || typeof args.after !== 'string' || !/^[a-zA-Z0-9_.:-]{0,64}$/.test(args.after) || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10) { throw new Failure('INVALID_ARGUMENTS'); }
        break;
    case 'state.put':
        change(args, request.realm.realm_uid);
        if (args.domain === 'undelete') { throw new Failure('RESTORATION_REQUIRES_RESERVATION'); }
        break;
    case 'state.begin':
        exact(args, ['change_count', 'chunk_count']);
        if (!Number.isInteger(args.change_count) || args.change_count < 1 || args.change_count > MAX_CHANGES ||
            !Number.isInteger(args.chunk_count) || args.chunk_count < 1 || args.chunk_count > MAX_CHUNKS ||
            args.chunk_count > args.change_count || args.change_count > args.chunk_count * 16) { throw new Failure('INVALID_ARGUMENTS'); }
        break;
    case 'state.prepare': case 'state.append': {
        exact(args, request.operation === 'state.append' ? ['reservation_id', 'index', 'changes'] : ['changes']);
        if (request.operation === 'state.append' && (!UUID.test(args.reservation_id) || !Number.isInteger(args.index) || args.index < 0 || args.index >= MAX_CHUNKS)) {
            throw new Failure('INVALID_ARGUMENTS');
        }
        if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 16) { throw new Failure('INVALID_ARGUMENTS'); }
        const seen = new Set();
        for (const value of args.changes) {
            change(value, request.realm.realm_uid);
            const key = value.domain + '/' + value.key;
            if (seen.has(key)) { throw new Failure('DUPLICATE_CHANGE'); }
            seen.add(key);
        }
        break;
    }
    case 'state.seal': case 'state.commit': case 'state.abort':
        exact(args, ['reservation_id']);
        if (!UUID.test(args.reservation_id)) { throw new Failure('INVALID_ARGUMENTS'); }
        break;
    case 'characters.read':
        exact(args, ['after', 'limit']);
        if (!Number.isInteger(args.after) || args.after < 0 || args.after > 65535 || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) { throw new Failure('INVALID_ARGUMENTS'); }
        break;
    case 'characters.summary':
        exact(args, ['count', 'last_character']);
        if (!Number.isInteger(args.count) || args.count < 0 || args.count > 255) { throw new Failure('INVALID_ARGUMENTS'); }
        if (args.last_character !== null) { id(args.last_character); }
        break;
    default: throw new Failure('UNSUPPORTED_OPERATION');
    }
    return request;
}
function fingerprint(request) {
    // A retry may have a later deadline; the operation and original identity cannot change.
    const payload = { ...request }; delete payload.deadline;
    return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}
module.exports = { validate, fingerprint, canonical, id, Failure, LIMIT, DOMAINS, MAX_CHANGES, MAX_CHUNKS, MAX_RESERVATION_BYTES };
