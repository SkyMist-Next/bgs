'use strict';
const crypto = require('node:crypto');
const { Failure, fingerprint } = require('./contract');
const { privilege } = require('../utils/admin-state');
const { realmPrefix, ticketKey } = require('./sessions');
const key = request => realmPrefix(request.realm.realm_uid) + 'handoffs/' + request.request_id;

async function issue(service, request, policy, transaction) {
    const args = request.arguments, rows = await service.realmDirectory.rows();
    const source = rows.find(row => row.realm_uid === request.realm.realm_uid);
    const target = rows.find(row => Number(row.region) === (args.realm_address >>> 24) &&
        Number(row.battlegroup) === ((args.realm_address >>> 16) & 255) && Number(row.realm_id) === (args.realm_address & 65535));
    if (!target || !source || !target.available || target.region !== policy.region || target.expansion !== policy.expansion ||
        !['build', 'version_major', 'version_minor', 'version_revision'].every(field => target[field] === source[field])) { throw new Failure('REALM_UNAVAILABLE'); }
    const security = await privilege(service.models, request.game_account_id, target.realm_uid, { transaction });
    if (security < target.security_level) { throw new Failure('REALM_UNAVAILABLE'); }
    const ticket = crypto.randomBytes(20).toString('hex'), secret = crypto.randomBytes(32).toString('hex');
    const record = { version: 1, namespace: target.namespace, realm_uid: target.realm_uid, game_account_id: request.game_account_id,
        account_id: policy.account_id, credential_version: policy.credential_version,
        authenticator_generation: policy.authenticator_generation, authenticator_verified_at: policy.authenticator_verified_at, expansion: policy.expansion, build: target.build, region: target.region, address: args.peer,
        locale: args.locale, platform: args.platform, gm_level: security, client_secret: args.client_secret, join_secret: secret };
    const endpoints = typeof target.endpoints === 'string' ? JSON.parse(target.endpoints) : target.endpoints;
    if (!Array.isArray(endpoints) || Buffer.byteLength(JSON.stringify(endpoints)) > 16384) { throw new Failure('INVALID_REALM_ENDPOINTS'); }
    const result = { server_addresses: JSON.stringify({ families: endpoints }), ticket, join_secret: secret };
    const outcomeKey = key(request), ticketPath = ticketKey(target.realm_uid, ticket), hash = fingerprint(request);
    await service.store.transaction([outcomeKey, ticketPath], async client => {
        const old = await client.get(outcomeKey);
        if (old) {
            if (JSON.parse(old).fingerprint !== hash) { throw new Failure('IDEMPOTENCY_CONFLICT'); }
            return { commands: [], result: null };
        }
        if (await client.get(ticketPath)) { throw new Failure('TICKET_COLLISION'); }
        return { commands: [['SET', ticketPath, JSON.stringify(record)],
            ['SET', outcomeKey, JSON.stringify({ fingerprint: hash, result }), 'EX', '300']], result: null };
    });
    // Durable SQL records only a reference. Ticket proofs and handoff state stay
    // in Redis; expiry never authorizes reissuing an already journaled request.
    return { handoff_reference: request.request_id };
}
async function hydrate(service, request, response) {
    if (response.result?.handoff_reference !== request.request_id) { throw new Failure('INVALID_HANDOFF_OUTCOME'); }
    const raw = await service.store.run(client => client.get(key(request)));
    if (!raw) { throw new Failure('HANDOFF_EXPIRED'); }
    const stored = JSON.parse(raw);
    if (stored.fingerprint !== fingerprint(request)) { throw new Failure('IDEMPOTENCY_CONFLICT'); }
    return { ...response, result: stored.result };
}
module.exports = { issue, hydrate };
