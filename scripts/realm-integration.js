'use strict';
// Explicitly opt-in; these ports must belong to the disposable fixture containers.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createClient } = require('redis');
const { Sequelize } = require('sequelize');
const mysql = require('mysql2/promise');
const amqp = require('amqplib');
const { Sessions, ticketKey, leaseKey } = require('../realm/sessions');
const RealmService = require('../realm/service');
const RealmReceiver = require('../realm/receiver');
const { validate, fingerprint } = require('../realm/contract');

async function main() {
    const clientBuild = Number(process.env.REALM_TEST_BUILD || 22900);
    assert([22900, 26972].includes(clientBuild), 'Unsupported native fixture build');
    const port = name => {
        const value = Number(process.env[name]);
        assert(Number.isInteger(value) && value > 1024 && value < 65536, 'Missing isolated fixture port: ' + name);
        return value;
    };
    const redis = createClient({ url: 'redis://127.0.0.1:' + port('REALM_TEST_REDIS_PORT'), disableOfflineQueue: true });
    redis.on('error', () => {});
    const root = await mysql.createConnection({ host: '127.0.0.1', port: port('REALM_TEST_DB_PORT'), user: 'root', password: 'local-validation-only' });
    const database = 'realm_validation_' + crypto.randomBytes(6).toString('hex');
    await root.query('CREATE DATABASE `' + database + '`');
    const sql = new Sequelize(database, 'root', 'local-validation-only', { host: '127.0.0.1', port: port('REALM_TEST_DB_PORT'), dialect: 'mysql', logging: false,
        dialectOptions: { supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true }, pool: { max: 5, acquire: 2000 } });
    let receiver, connection, publisher;
    const pending = new Map();
    try {
        await redis.connect();
        const store = { run: operation => operation(redis), transaction: async (keys, decide) => {
            const connection = redis.duplicate();
            connection.on('error', () => {});
            await connection.connect();
            try { return await require('../utils/redis-transaction').watched(connection, keys, decide); }
            finally { await connection.close(); }
        } };
        const sessions = new Sessions(store);
        const owner = { version: 1, namespace: 'integration', realm_uid: crypto.randomUUID(), pod_uid: crypto.randomUUID(),
            instance_id: crypto.randomUUID(), session_id: crypto.randomUUID(), game_account_id: String(9007199254740993n + BigInt(crypto.randomBytes(4).readUInt32BE())), account_id: '9007199254740995', generation: '0', expansion: 6, build: clientBuild, address: '127.0.0.1' };
        const ticket = crypto.randomBytes(20).toString('hex');
        const record = { ...owner, account_id: '9007199254740995', client_secret: '07'.repeat(32), join_secret: '08'.repeat(32),
            locale: 'enUS', platform: 'Win', gm_level: 3 };
        await sessions.issue(ticket, record);
        const observed = await redis.get(ticketKey(owner.realm_uid, ticket));
        const ticketTTL = await redis.ttl(ticketKey(owner.realm_uid, ticket));
        assert.ok(ticketTTL > 0 && ticketTTL <= 60, 'Join ticket must expire within 60 seconds');
        await assert.rejects(sessions.claim(ticket, observed, { ...owner, build: 1 }), /TICKET_IDENTITY_MISMATCH/);
        const claims = await Promise.allSettled([
            sessions.claim(ticket, observed, owner), sessions.claim(ticket, observed, { ...owner, session_id: crypto.randomUUID() })
        ]);
        assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
        const claimed = claims.find(result => result.status === 'fulfilled').value;
        Object.assign(owner, claimed);
        assert.equal(await redis.exists(ticketKey(owner.realm_uid, ticket)), 0);
        assert.deepEqual(await sessions.claim(ticket, observed, owner), owner, 'Lost claim acknowledgement is recoverable');
        assert((await redis.ttl(leaseKey(owner.game_account_id))) <= 90);
        await assert.rejects(sessions.update({ ...owner, pod_uid: crypto.randomUUID() }, 'release'), /SESSION_OWNERSHIP_LOST/);

        await require('../migrations/20261103000000-realm-gameplay').up(sql.getQueryInterface());
        await sql.query('CREATE TABLE game_accounts(id BIGINT PRIMARY KEY,account_id BIGINT, region TINYINT NOT NULL DEFAULT 1, expansion TINYINT NOT NULL, program CHAR(4), banned BOOLEAN DEFAULT FALSE, suspended BOOLEAN DEFAULT FALSE) ENGINE=InnoDB');
        await sql.query('INSERT INTO game_accounts(id,account_id,expansion,program) VALUES(?,?,6,\'WoW\')', { replacements: [owner.game_account_id, record.account_id] });
        await sql.query('CREATE TABLE game_account_privileges(game_account_id BIGINT,realm_uid VARCHAR(36),level TINYINT,PRIMARY KEY(game_account_id,realm_uid)) ENGINE=InnoDB');
        await sql.query('CREATE TABLE ip_bans(address VARCHAR(45) PRIMARY KEY,expires_at DATETIME(6) NULL) ENGINE=InnoDB');
        await sql.query('INSERT INTO game_account_privileges VALUES(?,\'\',2)', { replacements: [owner.game_account_id] });
        await require('../migrations/20261103000001-immutable-game-expansion').up(sql.getQueryInterface());
        await require('../migrations/20261103000002-realm-permissions').up(sql.getQueryInterface());
        await require('../migrations/20261103000003-staged-realm-reservations').up(sql.getQueryInterface());
        await require('../migrations/20261103000004-realm-process-permits').up(sql.getQueryInterface());
        await require('../migrations/20261103000005-game-account-options').up(sql.getQueryInterface());
        await require('../migrations/20261103000006-account-restoration').up(sql.getQueryInterface());
        await require('../migrations/20261103000003-staged-realm-reservations').up(sql.getQueryInterface());
        await sql.query('INSERT INTO game_account_permissions VALUES(?,\'\',123,1,UTC_TIMESTAMP(6))', { replacements: [owner.game_account_id] });
        await sql.query('INSERT INTO game_account_permissions VALUES(?,?,123,0,UTC_TIMESTAMP(6))', { replacements: [owner.game_account_id, owner.realm_uid] });
        await assert.rejects(sql.query('UPDATE game_accounts SET expansion=5'), /immutable/);
        const realm = { namespace: owner.namespace, realm_uid: owner.realm_uid, realm_id: 1, region: 1, battlegroup: 1, name: 'Fixture', game_type: 0, timezone: 1, pod_uid: owner.pod_uid, instance_id: owner.instance_id, available: 1, expansion: 6, build: clientBuild, security_level: 0,
            version_major: 7, version_minor: 1, version_revision: 0, endpoints: [{ family: 1, addresses: [{ ip: '127.0.0.1', port: 8085 }] }],
            desired_pod_uid: owner.pod_uid, desired_revision: 'a'.repeat(64) };
        const service = new RealmService({ models: {
            ...require('../models/realmgameplay')(sql, Sequelize.DataTypes),
            sequelize: sql,
            ipBansEnabled: true,
            IPBan: { findOne: async ({ where, transaction }) => {
                assert(transaction, 'World-entry IP checks must share the SQL authorization transaction');
                const [rows] = await sql.query('SELECT expires_at AS expiresAt FROM ip_bans WHERE address=?', { transaction, replacements: [where.address] });
                return rows[0] || null;
            } },
            Account: { findByPk: async account => ({ id: account }) },
            GameAccount: { findByPk: async (account, options) => {
                const [rows] = await sql.query('SELECT *,account_id AS accountId,banned AS isBanned,suspended AS isSuspended FROM game_accounts WHERE id=?', { ...options, replacements: [account] });
                return rows[0];
            } },
            GameAccountPrivilege: { findOne: async ({ where, transaction }) => {
                const [rows] = await sql.query('SELECT level FROM game_account_privileges WHERE game_account_id=? AND realm_uid=?', { transaction, replacements: [where.gameAccountId, where.realmUid] });
                return rows[0] || null;
            } }
        }, store, realmDirectory: { rows: async () => [realm] } });
        const request = (operation, args = {}) => ({ version: 1, request_id: crypto.randomUUID(), deadline: new Date(Date.now() + 30000).toISOString(),
            realm: { namespace: owner.namespace, realm_uid: owner.realm_uid, pod_uid: owner.pod_uid, instance_id: owner.instance_id },
            game_account_id: owner.game_account_id, session_id: owner.session_id, generation: owner.generation, operation, arguments: args });
        const opening = request('session.open');
        await sql.query('INSERT INTO ip_bans VALUES (?,NULL)', { replacements: [owner.address] });
        await assert.rejects(service.execute(opening), /IP_BANNED/, 'A ban after ticket issue must reject world entry');
        await sql.query('DELETE FROM ip_bans');
        const opened = await service.execute(opening);
        assert.equal(opened.result.generation, '1');
        assert.equal(opened.result.policy.game_account_id, owner.game_account_id);
        assert.equal(opened.result.policy.account_id, record.account_id);
        assert.equal(opened.result.policy.security_level, 2);
        assert.deepEqual(opened.result.policy.granted, [123]);
        assert.deepEqual(opened.result.policy.denied, [123]);
        assert.equal(opened.result.policy.mute_until, '0');
        assert.deepEqual(opened.result.policy.premium, {});
        const unboundOwner = { ...owner };
        Object.assign(owner, await sessions.update(owner, 'bind', opened.result.generation));
        const options = { mute_until: 4294967295, premium: { rate_xp_kill: 3, active: true } };
        await service.models.GameAccountOptions.create({ game_account_id: owner.game_account_id, options });
        const refreshed = (await service.execute(request('account.policy', { address: owner.address }))).result;
        assert.equal(refreshed.mute_until, '4294967295');
        assert.deepEqual(refreshed.premium, options.premium, 'Policy refresh must read persisted options through the ORM without losing JSON types');
        await service.models.GameAccountOptions.destroy({ where: { game_account_id: owner.game_account_id } });
        await sql.query('UPDATE game_account_privileges SET level=0 WHERE game_account_id=?', { replacements: [owner.game_account_id] });
        assert.equal((await service.execute(request('account.policy', { address: owner.address }))).result.security_level, 0);
        await sql.query('INSERT INTO ip_bans VALUES (?,NULL)', { replacements: ['192.0.2.12'] });
        await assert.rejects(service.execute(request('account.policy', { address: '192.0.2.12' })), /IP_BANNED/,
            'Continued-session policy must check the actual instance peer too');
        await sql.query("UPDATE ip_bans SET expires_at='2000-01-01 00:00:00'");
        assert.equal((await service.execute(request('account.policy', { address: '192.0.2.12' }))).result.security_level, 0);
        await sql.query('UPDATE game_accounts SET account_id=9007199254740997 WHERE id=?', { replacements: [owner.game_account_id] });
        await assert.rejects(service.execute(request('account.policy', { address: owner.address })), /ACCOUNT_OWNERSHIP_CHANGED/);
        await sql.query('UPDATE game_accounts SET account_id=? WHERE id=?', { replacements: [record.account_id, owner.game_account_id] });
        assert.deepEqual(await sessions.update(unboundOwner, 'bind', opened.result.generation), owner);
        await sessions.update(owner, 'renew');
        assert.equal(await redis.ttl(leaseKey(owner.game_account_id)), 90);
        const continuation = { session_id: owner.session_id, generation: owner.generation, key: '11'.repeat(40) };
        const token = crypto.randomBytes(16).toString('hex');
        await sessions.continuation(owner, token, 'put', continuation);
        assert.deepEqual(await sessions.continuation(owner, token, 'take'), { ...continuation, owner });
        await assert.rejects(sessions.continuation(owner, token, 'take'), /CONTINUATION_UNAVAILABLE/);

        const username = 'realm-' + owner.realm_uid;
        const management = 'http://127.0.0.1:' + port('REALM_TEST_MANAGEMENT_PORT') + '/api/';
        const put = async (path, body) => {
            const response = await fetch(management + path, { method: 'PUT', headers: { authorization: 'Basic ' + Buffer.from('fixture:local-validation-only').toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
            assert(response.ok, 'Broker fixture provisioning failed: ' + response.status);
        };
        await put('vhosts/skymist-realms', {});
        await put('users/' + username, { password: 'local-validation-only', tags: '' });
        const ownReplyQueue = '^realm\\.reply\\.' + owner.realm_uid + '\\.[a-f0-9-]{36}$';
        await put('permissions/skymist-realms/' + username, { configure: ownReplyQueue, write: '^skymist\\.realm\\.rpc\\.v1$', read: ownReplyQueue });
        const worker = 'worker-' + crypto.randomUUID();
        await put('users/' + worker, { password: 'local-validation-only', tags: '' });
        await put('permissions/skymist-realms/' + worker, { configure: '^skymist\\.realm\\.rpc\\.v1(\\.requests)?$', write: '^(skymist\\.realm\\.rpc\\.v1\\.requests|amq\\.default)$', read: '^skymist\\.realm\\.rpc\\.v1(\\.requests)?$' });
        const broker = '@127.0.0.1:' + port('REALM_TEST_AMQP_PORT') + '/skymist-realms';
        connection = await amqp.connect('amqp://' + worker + ':local-validation-only' + broker);
        let fatal;
        receiver = new RealmReceiver(service, { amqpConnection: connection, isAccepting: () => true, onFatal: error => { fatal = error; } });
        const receive = receiver.receive.bind(receiver);
        receiver.receive = async message => {
            if (message) {
                try { validate(message.content, message.properties); }
                catch (error) { console.error('Fixture request validation:', error.code); throw error; }
            }
            try { return await receive(message); }
            catch (error) { console.error('Fixture receive failed:', error.message, error.cause?.message); throw error; }
        };
        await receiver.start();
        publisher = await amqp.connect('amqp://' + username + ':local-validation-only' + broker);
        const channel = await publisher.createConfirmChannel();
        const replyTo = 'realm.reply.' + owner.realm_uid + '.' + crypto.randomUUID();
        await channel.assertQueue(replyTo, { exclusive: true, autoDelete: true, durable: false });
        await channel.consume(replyTo, message => {
            if (!message) { return; }
            const waiter = pending.get(message.properties.correlationId);
            if (waiter) { waiter.resolve(JSON.parse(message.content)); pending.delete(message.properties.correlationId); }
        }, { noAck: true });
        const call = async value => {
            const properties = { contentType: 'application/json', correlationId: value.request_id, userId: username, replyTo, persistent: true };
            validate(Buffer.from(JSON.stringify(value)), properties);
            const response = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(value.request_id); reject(new Error('Fixture RPC timed out')); }, 5000);
                pending.set(value.request_id, { resolve: result => { clearTimeout(timer); resolve(result); } });
            });
            // Observe both operations even if confirmation fails.
            const confirmation = new Promise((resolve, reject) => channel.publish('skymist.realm.rpc.v1', 'request', Buffer.from(JSON.stringify(value)), properties, error => error ? reject(error) : resolve()));
            const [result] = await Promise.all([response, confirmation]);
            return result;
        };
        const mutation = request('state.put', { domain: 'mounts', key: '123', revision: '0', value: { flags: 1 } });
        const handoff = request('client.join', { realm_address: 0x01010001, client_secret: '11'.repeat(32), locale: 'enUS', platform: 'Win', peer: '127.0.0.1' });
        const transfer = await call(handoff);
        assert.equal(transfer.status, 'success');
        assert.deepEqual(await call(handoff), transfer, 'A lost handoff reply must recover the same Redis-backed ticket');
        const issued = JSON.parse(await redis.get(ticketKey(owner.realm_uid, transfer.result.ticket)));
        assert.equal(issued.game_account_id, owner.game_account_id);
        assert.equal(issued.client_secret, handoff.arguments.client_secret);
        assert.equal(issued.join_secret, transfer.result.join_secret);
        const journal = await service.models.RealmRPCOutcome.findOne({ where: { realm_uid: owner.realm_uid, request_id: handoff.request_id }, raw: true });
        assert(!JSON.stringify(journal.response).includes(transfer.result.join_secret), 'Ticket proofs must remain in Redis rather than the durable SQL outcome journal');
        await redis.del(ticketKey(owner.realm_uid, transfer.result.ticket));
        assert.deepEqual(await call(handoff), transfer);
        assert.equal(await redis.exists(ticketKey(owner.realm_uid, transfer.result.ticket)), 0, 'Retry must not reissue a consumed join ticket');
        await redis.del('/skymist/v1/realms/' + owner.realm_uid + '/handoffs/' + handoff.request_id);
        assert.equal((await call(handoff)).error.code, 'HANDOFF_EXPIRED');
        const changed = await call(mutation);
        assert.equal(changed.status, 'success'); assert.equal(changed.result.revision, '1');
        assert.deepEqual(await call(mutation), changed, 'Duplicate RPC mutated state twice');
        const conflict = await call({ ...mutation, arguments: { ...mutation.arguments, value: { flags: 2 } } });
        assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
        const stale = await call(request('state.put', { ...mutation.arguments, value: { flags: 3 } }));
        assert.equal(stale.error.code, 'REVISION_CONFLICT');
        assert.equal((await call(request('state.read', { domain: 'mounts', after: '', limit: 10 }))).result.items[0].revision, '1');
        const start = performance.now();
        for (let batch = 0; batch < 5; batch++) {
            const results = await Promise.all(Array.from({ length: 10 }, (_, index) => call(request('state.put', { domain: 'toys', key: String(batch * 10 + index), revision: '0', value: { favorite: false } }))));
            assert(results.every(result => result.status === 'success'));
        }
        const elapsed = performance.now() - start;
        const primitiveValues = ['a JSON string', '{"looks":"like json"}', '\u0418\u043c\u0435\ud83d\ude00', null, false, [1, '18446744073709551615'], { counter: '18446744073709551615' }];
        for (let index = 0; index < primitiveValues.length; index++) {
            assert.equal((await call(request('state.put', { domain: 'toys', key: 'state-json.' + index, revision: '0', value: primitiveValues[index] }))).status, 'success');
        }
        const primitivePage = (await call(request('state.read', { domain: 'toys', after: 'state-json.', limit: 10 }))).result;
        assert.deepEqual(primitivePage.items.map(item => item.value), primitiveValues, 'ORM JSON decoding must preserve strings, Unicode, primitives and large decimal counters');
        assert.equal((await call(request('characters.summary', { count: 2, last_character: '9007199254740993' }))).status, 'success');
        assert.deepEqual((await call(request('characters.read', { after: 0, limit: 100 }))).result.items, [{ realm_id: 1, region: 1, battlegroup: 1, count: 2 }]);
        const summary = { domain: 'characters', key: owner.realm_uid, revision: '0', value: { count: 3, last_character: '9007199254740993' } };
        const rejectedSummary = request('state.prepare', { changes: [summary] });
        assert.equal((await call(rejectedSummary)).status, 'success');
        assert.equal((await call(request('state.abort', { reservation_id: rejectedSummary.request_id }))).result.status, 'aborted');
        assert.equal((await call(request('characters.read', { after: 0, limit: 100 }))).result.items[0].count, 2, 'Character rollback must leave its shared count unchanged');
        const committedSummary = request('state.prepare', { changes: [summary] });
        assert.equal((await call(committedSummary)).status, 'success');
        assert.equal((await call(request('state.commit', { reservation_id: committedSummary.request_id }))).result.status, 'committed');
        assert.equal((await call(request('characters.read', { after: 0, limit: 100 }))).result.items[0].count, 3);
        assert.deepEqual((await call(request('state.read', { domain: 'characters', after: '', limit: 10 }))).result.items,
            [{ key: owner.realm_uid, revision: '1', value: summary.value }], 'The summary index and revisioned state must commit together');
        const restore = { domain: 'undelete', key: record.account_id, revision: '0', value: { cooldown: 2592000, token: crypto.randomUUID() } };
        const interruptedRestore = request('state.prepare', { changes: [restore] });
        assert.equal((await call(interruptedRestore)).status, 'success');
        await assert.rejects(sql.transaction(transaction => service.reserveRestoration([restore], record.account_id, owner.realm_uid, crypto.randomUUID(), transaction)),
            /RESTORATION_PENDING/, 'Another GameAccount under the same parent must not reserve a concurrent restoration');
        assert.equal((await call(request('state.abort', { reservation_id: interruptedRestore.request_id }))).result.status, 'aborted');
        assert.equal((await call(request('account.restore-policy'))).result.last_restore, 0, 'A rolled-back character restoration must not consume its cooldown');
        const completedRestore = request('state.prepare', { changes: [restore] });
        assert.equal((await call(completedRestore)).status, 'success');
        assert.equal((await call(request('state.commit', { reservation_id: completedRestore.request_id }))).result.status, 'committed');
        assert((await call(request('account.restore-policy'))).result.last_restore > 0);
        assert.equal((await call(request('state.prepare', { changes: [{ ...restore, revision: '1', value: { ...restore.value, token: crypto.randomUUID() } }] }))).error.code,
            'RESTORATION_COOLDOWN');
        const stagedReservations = await require('./staged-realm-fixture')({ call, request, sql, owner });
        const preparation = request('state.prepare', { changes: [{ domain: 'pets', key: 'caged-pet', revision: '0', value: { deleted: true } }] });
        const prepared = await call(preparation);
        assert.equal(prepared.result.reservation_id, preparation.request_id);
        assert.equal((await call(request('state.put', { domain: 'mounts', key: '456', revision: '0', value: {} }))).error.code, 'MUTATION_RECOVERY_REQUIRED');
        await sessions.update(owner, 'release');
        const nextOwner = { ...owner, generation: '0', session_id: crypto.randomUUID() };
        const nextTicket = crypto.randomBytes(20).toString('hex');
        await sessions.issue(nextTicket, record);
        await sessions.claim(nextTicket, await redis.get(ticketKey(owner.realm_uid, nextTicket)), nextOwner);
        const nextOpen = { ...request('session.open'), generation: '0', session_id: nextOwner.session_id };
        assert.equal((await call(nextOpen)).error.code, 'MUTATION_RECOVERY_REQUIRED');
        const pendingRequest = { ...request('state.pending', { after: '', limit: 100 }), game_account_id: '0', generation: '0' };
        assert.equal((await call(pendingRequest)).result.items[0].request_id, preparation.request_id);
        assert.equal((await call(pendingRequest)).result.items[0].account_id, record.account_id);
        const commit = request('state.commit', { reservation_id: preparation.request_id });
        assert.equal((await call(commit)).result.status, 'committed', 'Durable reservation was lost with the transient session');
        assert.equal((await call(commit)).result.revisions[0].revision, '1');
        assert.equal((await call(request('state.abort', { reservation_id: preparation.request_id }))).error.code, 'RESERVATION_ALREADY_COMMITTED');
        const resumed = await call(nextOpen);
        assert.equal(resumed.result.generation, '2');
        Object.assign(nextOwner, await sessions.update(nextOwner, 'bind', resumed.result.generation));
        const nextRequest = (operation, args) => ({ ...request(operation, args), session_id: nextOwner.session_id, generation: nextOwner.generation });
        const interrupted = nextRequest('state.begin', { change_count: 17, chunk_count: 2 });
        assert.equal((await call(interrupted)).status, 'success');
        assert.equal((await call(nextRequest('state.append', { reservation_id: interrupted.request_id, index: 0,
            changes: [{ domain: 'toys', key: 'expired-upload', revision: '0', value: true }] }))).status, 'success');
        await sessions.update(nextOwner, 'release');
        const abandonedUpload = (await call(pendingRequest)).result.items.find(row => row.request_id === interrupted.request_id);
        assert.equal(abandonedUpload.status, 'staging', 'Interrupted uploads must remain discoverable after lease loss');
        assert.equal((await call(nextRequest('state.abort', { reservation_id: interrupted.request_id }))).result.status, 'aborted');
        const [[unapplied]] = await sql.query("SELECT COUNT(*) AS count FROM game_account_state WHERE entity_key='expired-upload'");
        assert.equal(Number(unapplied.count), 0, 'Lease loss must not apply a partial upload');
        // A lost response remains discoverable after the session expires or the pod restarts.
        assert.deepEqual(await call(mutation), changed);
        assert.equal((await call(request('state.read', { domain: 'mounts', after: '', limit: 10 }))).error.code, 'SESSION_OWNERSHIP_LOST');
        assert.equal(fatal, undefined);
        assert.equal(fingerprint(mutation), fingerprint({ ...mutation, deadline: new Date().toISOString() }));
        const nativeAdmission = process.env.REALM_NATIVE_IMAGE ? await require('./native-realm-fixture')({
            redis, sessions, owner, record, port, database, sql, image: process.env.REALM_NATIVE_IMAGE }) : 'not-requested';
        const permitArgs = { revision: realm.desired_revision, build: realm.build, expansion: realm.expansion, previous_epoch: '', epoch: crypto.randomUUID() };
        const processCall = (instance, operation, args) => call({ ...request(operation, args), realm: { ...request(operation).realm, instance_id: instance }, game_account_id: '0', generation: '0' });
        const firstProcess = crypto.randomUUID(), secondProcess = crypto.randomUUID();
        assert.equal((await processCall(firstProcess, 'process.claim', permitArgs)).status, 'success');
        assert.equal((await processCall(firstProcess, 'process.claim', permitArgs)).result.epoch, permitArgs.epoch);
        const nextPermit = { ...permitArgs, previous_epoch: permitArgs.epoch, epoch: crypto.randomUUID() };
        assert.equal((await processCall(secondProcess, 'process.claim', nextPermit)).status, 'success');
        assert.equal((await processCall(firstProcess, 'process.claim', permitArgs)).error.code, 'PROCESS_OWNERSHIP_LOST');
        const checkPermit = { ...nextPermit }; delete checkPermit.previous_epoch;
        assert.equal((await processCall(firstProcess, 'process.check', { ...checkPermit, epoch: permitArgs.epoch })).error.code, 'PROCESS_OWNERSHIP_LOST');
        assert.equal((await processCall(secondProcess, 'process.check', checkPermit)).status, 'success');
        assert.equal((await processCall(secondProcess, 'process.check', { ...checkPermit, epoch: crypto.randomUUID() })).error.code, 'PROCESS_PERMIT_CONFLICT');
        realm.desired_pod_uid = crypto.randomUUID();
        assert.equal((await processCall(secondProcess, 'process.claim', nextPermit)).error.code, 'PROCESS_NOT_SELECTED');
        realm.desired_pod_uid = owner.pod_uid;
        // Draining closes admission, while the last acknowledged process owner
        // may finish an existing character save before the SQL epoch is replaced.
        realm.instance_id = secondProcess;
        const closingOwner = { ...owner, instance_id: secondProcess, session_id: crypto.randomUUID(), generation: '0' };
        const closingTicket = crypto.randomBytes(20).toString('hex');
        await sessions.issue(closingTicket, record);
        await sessions.claim(closingTicket, await redis.get(ticketKey(owner.realm_uid, closingTicket)), closingOwner);
        const closingRequest = (operation, args = {}) => ({ ...request(operation, args), realm: { ...request(operation).realm, instance_id: secondProcess },
            session_id: closingOwner.session_id, generation: closingOwner.generation });
        const closingOpen = await call(closingRequest('session.open'));
        assert.equal(closingOpen.status, 'success');
        Object.assign(closingOwner, await sessions.update(closingOwner, 'bind', closingOpen.result.generation));
        const oldBuild = realm.build;
        realm.available = 0; realm.desired_pod_uid = null; realm.build++;
        assert.equal((await processCall(secondProcess, 'process.check', checkPermit)).result.draining, true);
        await sql.query('UPDATE game_accounts SET banned=1 WHERE id=?', { replacements: [owner.game_account_id] });
        assert.equal((await call(closingRequest('account.policy', { address: owner.address }))).error.code, 'ACCOUNT_UNAVAILABLE');
        const finalSave = closingRequest('state.prepare', { changes: [{ domain: 'toys', key: 'closing-save', revision: '0', value: true }] });
        assert.equal((await call(finalSave)).status, 'success', 'An offline realm or newly banned owner must not lose already earned progress during its final flush');
        assert.equal((await call(closingRequest('state.commit', { reservation_id: finalSave.request_id }))).result.status, 'committed');
        await sessions.update(closingOwner, 'release');
        await sql.query('UPDATE game_accounts SET banned=0 WHERE id=?', { replacements: [owner.game_account_id] });
        realm.available = 1; realm.desired_pod_uid = owner.pod_uid; realm.build = oldBuild;
        assert.equal(fatal, undefined);
        console.log(JSON.stringify({ database, redisRaces: 'passed', continuation: 'passed', rpcIdempotency: 'passed', immutableExpansion: 'passed', stagedReservations, processPermits: 'passed', committedOperations: 50, elapsedMs: Math.round(elapsed), nativeAdmission }));
    } finally {
        await receiver?.drain();
        await publisher?.close();
        await connection?.close();
        if (redis.isOpen) { await redis.close(); }
        await sql.close(); await root.end();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
