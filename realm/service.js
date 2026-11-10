'use strict';
const { Op, fn, col } = require('sequelize');
const { Failure, fingerprint, canonical, MAX_RESERVATION_BYTES } = require('./contract');
const { blocked, privilege, checkIP } = require('../utils/admin-state');
const { owner: sessionOwner } = require('./sessions');
const { requireProof, wireProof, metadata } = require('../utils/authenticator');
const { licenseIndex } = require('../utils/wow-license');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

class RealmService {
    constructor({ models, store, realmDirectory, clock = Date.now }) {
        Object.assign(this, { models, store, realmDirectory, clock });
    }
    async authorizeRealm(request) {
        const realm = (await this.realmDirectory.rows()).find(row => row.realm_uid === request.realm.realm_uid && row.namespace === request.realm.namespace);
        if (!realm) { throw new Failure('REALM_UNAVAILABLE'); }
        return realm;
    }
    async authorize(request, transaction) {
        const r = request.realm;
        const rawLease = await this.store.run(client => client.get('/skymist/v1/sessions/' + request.game_account_id));
        if (!rawLease) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
        const lease = sessionOwner(JSON.parse(rawLease));
        if (lease.version !== 1 || lease.session_id !== request.session_id || lease.game_account_id !== request.game_account_id ||
            !Object.keys(r).every(k => lease[k] === r[k])) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
        if (request.operation !== 'session.open' && lease.generation !== request.generation) { throw new Failure('STALE_SESSION'); }
        const game = await this.models.GameAccount.findByPk(request.game_account_id, { transaction });
        const account = game && await this.models.Account.findByPk(String(game.accountId), { transaction });
        if (!game || !account || game.program !== 'WoW') { throw new Failure('ACCOUNT_UNAVAILABLE'); }
        if (lease.account_id !== String(game.accountId)) { throw new Failure('ACCOUNT_OWNERSHIP_CHANGED'); }
        const process = await this.models.RealmProcessOwner.findByPk(r.realm_uid, { transaction, raw: true });
        if (process && process.instance_id !== r.instance_id) { throw new Failure('PROCESS_OWNERSHIP_LOST'); }
        let persistence = false;
        if (process && ['state.prepare', 'state.begin', 'state.append', 'state.seal'].includes(request.operation)) {
            const permit = await this.models.RealmProcessPermit.findOne({ where: { realm_uid: r.realm_uid, instance_id: r.instance_id, pod_uid: r.pod_uid }, transaction, raw: true });
            persistence = Boolean(permit && Number(permit.build) === lease.build && Number(permit.expansion) === game.expansion);
        }
        if (!persistence) {
            try { requireProof(account, wireProof(lease), this.clock()); }
            catch { throw new Failure('AUTHENTICATION_REVOKED'); }
            try {
                await checkIP(this.models, lease.address, this.clock(), { transaction });
                if (request.operation === 'account.policy') { await checkIP(this.models, request.arguments.address, this.clock(), { transaction }); }
                if (request.operation === 'client.join') { await checkIP(this.models, request.arguments.peer, this.clock(), { transaction }); }
            } catch (error) {
                if (error === 0xA) { throw new Failure('IP_BANNED'); }
                throw error;
            }
        }
        // A selected replacement or account ban closes gameplay immediately.
        // The existing SQL owner can still flush captured progress while it
        // drains; a new process claim plus the character SQL fence ends this.
        if (!persistence && (blocked(game) || blocked(account))) { throw new Failure('ACCOUNT_UNAVAILABLE'); }
        const realm = await this.authorizeRealm(request);
        const security = await privilege(this.models, game.id, r.realm_uid, { transaction });
        if (!persistence && (!realm.available || realm.pod_uid !== r.pod_uid || realm.instance_id !== r.instance_id ||
            realm.expansion !== game.expansion || realm.region !== game.region || realm.build !== lease.build || security < realm.security_level)) { throw new Failure('REALM_UNAVAILABLE'); }
        const policy = { game_account_id: String(game.id), account_id: String(game.accountId), expansion: game.expansion,
            security_level: security, region: game.region, display_name: game.displayName || String(game.id) };
        const authentication = metadata(account);
        policy.credential_version = authentication.credentialVersion;
        policy.authenticator_generation = authentication.authenticatorGeneration;
        policy.authenticator_verified_at = wireProof(lease).authenticatorVerifiedAt;
        if (lease.build === 15595) {
            try { policy.wow_license_index = licenseIndex(game.wowLicenseIndex); }
            catch { throw new Failure('ACCOUNT_IDENTITY_INVALID'); }
        }
        if (['session.open', 'account.policy'].includes(request.operation)) {
            const rows = await this.models.GameAccountPermission.findAll({
                where: { game_account_id: request.game_account_id, realm_uid: { [Op.in]: ['', r.realm_uid] } },
                attributes: ['permission_id', 'granted'], order: [['permission_id', 'ASC'], ['realm_uid', 'ASC']], limit: 8193, transaction, raw: true
            });
            if (rows.length > 8192) { throw new Failure('POLICY_LIMIT'); }
            policy.granted = [...new Set(rows.filter(row => Number(row.granted) === 1).map(row => row.permission_id))];
            policy.denied = [...new Set(rows.filter(row => Number(row.granted) !== 1).map(row => row.permission_id))];
            const row = await this.models.GameAccountOptions.findByPk(request.game_account_id, { transaction, raw: true });
            const options = row ? json(row.options) : {};
            policy.mute_until = String(options.mute_until ?? 0);
            policy.premium = options.premium ?? {};
        }
        return policy;
    }
    async checkRevision(account, change, transaction) {
        const row = await this.models.GameAccountState.findOne({
            where: { game_account_id: account, domain: change.domain, entity_key: change.key }, attributes: ['revision'],
            transaction, lock: transaction.LOCK.UPDATE, raw: true
        });
        if (String(row?.revision ?? 0) !== change.revision) { throw new Failure('REVISION_CONFLICT'); }
        const revision = String(BigInt(change.revision) + 1n);
        if (BigInt(revision) > 9223372036854775807n) { throw new Failure('REVISION_EXHAUSTED'); }
        return revision;
    }
    async put(account, change, transaction, realmUID) {
        if (change.domain === 'characters' && change.key !== realmUID) { throw new Failure('INVALID_CHARACTER_REALM'); }
        const revision = await this.checkRevision(account, change, transaction);
        // Sequelize v6 maps JS null to SQL NULL. Produce JSON null through the
        // expression API while retaining the database's NOT NULL guarantee.
        const value = change.value === null ? fn('JSON_EXTRACT', 'null', '$') : change.value;
        await this.models.GameAccountState.upsert({ game_account_id: account, domain: change.domain, entity_key: change.key, revision, value }, { transaction });
        if (change.domain === 'characters') {
            await this.models.GameAccountCharacters.upsert({ game_account_id: account, realm_uid: realmUID,
                character_count: change.value.count, last_character: change.value.last_character }, { transaction });
        }
        return { revision };
    }
    reservationWhere(request, id = request.arguments.reservation_id) {
        return { realm_uid: request.realm.realm_uid, request_id: id, game_account_id: request.game_account_id };
    }
    async reserveRestoration(changes, parent, realmUID, reservationID, transaction) {
        const restores = changes.filter(change => change.domain === 'undelete');
        if (!restores.length) { return; }
        if (restores.length !== 1 || restores[0].key !== parent) { throw new Failure('INVALID_RESTORATION_PARENT'); }
        const where = { account_id: parent };
        await this.models.AccountRestoration.bulkCreate([where], { updateOnDuplicate: ['account_id'], transaction });
        const row = await this.models.AccountRestoration.findOne({ where, transaction, lock: transaction.LOCK.UPDATE, raw: true });
        if (row.pending_request_id) { throw new Failure('RESTORATION_PENDING'); }
        const now = Math.floor(this.clock() / 1000);
        if (Number(row.last_restore) && Number(row.last_restore) + restores[0].value.cooldown > now) { throw new Failure('RESTORATION_COOLDOWN'); }
        await this.models.AccountRestoration.update({ pending_realm_uid: realmUID, pending_request_id: reservationID, pending_at: now }, { where, transaction });
    }
    async finishRestoration(changes, parent, realmUID, reservationID, committed, transaction) {
        if (!changes.some(change => change.domain === 'undelete')) { return; }
        const where = { account_id: parent };
        const row = await this.models.AccountRestoration.findOne({ where, transaction, lock: transaction.LOCK.UPDATE, raw: true });
        if (!row || row.pending_realm_uid !== realmUID || row.pending_request_id !== reservationID) { throw new Failure('RESTORATION_FENCE_LOST'); }
        await this.models.AccountRestoration.update({ ...(committed ? { last_restore: row.pending_at } : {}),
            pending_request_id: null, pending_realm_uid: null, pending_at: 0 }, { where, transaction });
    }
    async staged(request, session, transaction) {
        const args = request.arguments, reservationID = args.reservation_id;
        const row = await this.models.GameAccountReservation.findOne({ where: this.reservationWhere(request), transaction, lock: transaction.LOCK.UPDATE, raw: true });
        if (!row || row.session_id !== request.session_id || String(row.generation) !== request.generation ||
            row.pod_uid !== request.realm.pod_uid || row.instance_id !== request.realm.instance_id) { throw new Failure('RESERVATION_NOT_FOUND'); }
        if (row.status !== 'staging' || session.pending_request_id !== reservationID) { throw new Failure('RESERVATION_NOT_STAGING'); }
        const chunksWhere = { realm_uid: request.realm.realm_uid, reservation_id: reservationID };
        if (request.operation === 'state.append') {
            if (args.index >= row.expected_chunks) { throw new Failure('INVALID_CHUNK_INDEX'); }
            const old = await this.models.GameAccountReservationChunk.findOne({ where: { ...chunksWhere, chunk_index: args.index }, transaction, raw: true });
            if (old) {
                if (canonical(json(old.changes)) !== canonical(args.changes)) { throw new Failure('CHUNK_CONFLICT'); }
            } else {
                const totals = await this.models.GameAccountReservationChunk.findOne({
                    where: chunksWhere,
                    attributes: [[fn('COALESCE', fn('SUM', fn('JSON_LENGTH', col('changes'))), 0), 'changes_count'],
                        [fn('COALESCE', fn('SUM', fn('OCTET_LENGTH', col('changes'))), 0), 'bytes_count']], transaction, raw: true
                });
                if (Number(totals.changes_count) + args.changes.length > row.expected_changes || Number(totals.bytes_count) + Buffer.byteLength(JSON.stringify(args.changes)) > MAX_RESERVATION_BYTES) {
                    throw new Failure('RESERVATION_LIMIT');
                }
                await this.models.GameAccountReservationChunk.create({ ...chunksWhere, chunk_index: args.index, changes: args.changes }, { transaction });
            }
            return { reservation_id: reservationID, index: args.index };
        }
        const rows = await this.models.GameAccountReservationChunk.findAll({ where: chunksWhere, order: [['chunk_index', 'ASC']], transaction, raw: true });
        if (rows.length !== Number(row.expected_chunks) || rows.some((chunk, index) => Number(chunk.chunk_index) !== index)) { throw new Failure('INCOMPLETE_RESERVATION'); }
        const changes = rows.flatMap(chunk => json(chunk.changes));
        if (changes.length !== Number(row.expected_changes)) { throw new Failure('INCOMPLETE_RESERVATION'); }
        const seen = new Set();
        for (const change of changes) {
            const key = change.domain + '/' + change.key;
            if (seen.has(key)) { throw new Failure('DUPLICATE_CHANGE'); }
            seen.add(key);
            await this.checkRevision(request.game_account_id, change, transaction);
        }
        await this.reserveRestoration(changes, String(row.account_id), request.realm.realm_uid, reservationID, transaction);
        await this.models.GameAccountReservation.update({ changes, status: 'prepared' }, { where: this.reservationWhere(request), transaction });
        await this.models.GameAccountReservationChunk.destroy({ where: chunksWhere, transaction });
        return { reservation_id: reservationID, change_count: changes.length };
    }
    async recover(request, session, transaction) {
        await this.authorizeRealm(request);
        const reservationID = request.arguments.reservation_id;
        const row = await this.models.GameAccountReservation.findOne({ where: this.reservationWhere(request), transaction, lock: transaction.LOCK.UPDATE, raw: true });
        if (!row || row.session_id !== request.session_id || String(row.generation) !== request.generation) { throw new Failure('RESERVATION_NOT_FOUND'); }
        const status = request.operation === 'state.commit' ? 'committed' : 'aborted';
        if (row.status === 'staging' && status === 'committed') { throw new Failure('RESERVATION_NOT_PREPARED'); }
        if (!['staging', 'prepared', status].includes(row.status)) { throw new Failure('RESERVATION_ALREADY_' + row.status.toUpperCase()); }
        const changes = json(row.changes);
        if (['staging', 'prepared'].includes(row.status)) {
            if (session.pending_request_id !== reservationID) { throw new Failure('RESERVATION_FENCE_LOST'); }
            if (status === 'committed') { for (const change of changes) { await this.put(request.game_account_id, change, transaction, request.realm.realm_uid); } }
            await this.finishRestoration(changes, String(row.account_id), request.realm.realm_uid, reservationID, status === 'committed', transaction);
            await this.models.GameAccountReservation.update({ status }, { where: this.reservationWhere(request), transaction });
            await this.models.GameAccountSession.update({ pending_request_id: null }, { where: { game_account_id: request.game_account_id }, transaction });
            await this.models.GameAccountReservationChunk.destroy({ where: { realm_uid: request.realm.realm_uid, reservation_id: reservationID }, transaction });
        }
        if (Number(row.expected_changes) > 0) { return { reservation_id: reservationID, status, change_count: Number(row.expected_changes) }; }
        return { reservation_id: reservationID, status,
            revisions: status === 'committed' ? changes.map(change => ({ domain: change.domain, key: change.key, revision: String(BigInt(change.revision) + 1n) })) : [] };
    }
    async execute(request) {
        if (request.operation === 'guild.publish') { return require('./guild')(this, request); }
        if (['process.claim', 'process.check'].includes(request.operation)) { return require('./processes')(this, request); }
        if (['realm.probe', 'realm.catalog', 'realm.authenticators', 'state.pending'].includes(request.operation)) {
            if (Date.parse(request.deadline) <= this.clock()) { throw new Failure('DEADLINE_EXPIRED'); }
            const realm = await this.authorizeRealm(request);
            let result = { build: realm.build, expansion: realm.expansion };
            if (request.operation === 'realm.authenticators') {
                const process = await this.models.RealmProcessOwner.findByPk(realm.realm_uid, { raw: true });
                if (!realm.available || realm.pod_uid !== request.realm.pod_uid || realm.instance_id !== request.realm.instance_id ||
                    !process || process.instance_id !== request.realm.instance_id) { throw new Failure('PROCESS_OWNERSHIP_LOST'); }
                // One SQL snapshot exposes enrollment metadata only, including offline members.
                const [items] = await this.models.sequelize.query(`SELECT CAST(g.id AS CHAR) game_account_id,
                    CAST(a.id AS CHAR) account_id, CAST(a.authenticator_generation AS CHAR) generation,
                    a.authenticator_state state FROM game_accounts g JOIN accounts a ON a.id=g.account_id
                    WHERE g.id IN (:ids) AND g.program='WoW' AND g.expansion=:expansion AND g.region=:region`,
                { replacements: { ids: request.arguments.game_accounts, expansion: realm.expansion, region: realm.region } });
                result = { items };
            }
            if (request.operation === 'realm.catalog') {
                const items = (await this.realmDirectory.rows()).filter(row => row.build === realm.build && row.expansion === realm.expansion && row.realm_uid > request.arguments.after)
                    .sort((a, b) => a.realm_uid.localeCompare(b.realm_uid)).slice(0, request.arguments.limit)
                    .map(row => ({ realm_uid: row.realm_uid, realm_id: Number(row.realm_id), region: Number(row.region), battlegroup: Number(row.battlegroup),
                        name: row.name, game_type: Number(row.game_type), timezone: Number(row.timezone), security_level: Number(row.security_level),
                        available: Boolean(row.available), population: Number(row.population || 0) }));
                result = { items, next: items.length === request.arguments.limit ? items.at(-1).realm_uid : null };
            }
            if (request.operation === 'state.pending') {
                const rows = await this.models.GameAccountReservation.findAll({
                    where: { realm_uid: request.realm.realm_uid, status: { [Op.in]: ['staging', 'prepared'] }, request_id: { [Op.gt]: request.arguments.after } },
                    attributes: ['request_id', 'game_account_id', 'account_id', 'session_id', 'generation', 'pod_uid', 'instance_id', 'status'],
                    order: [['request_id', 'ASC']], limit: request.arguments.limit, raw: true
                });
                result = { items: rows.map(row => ({ ...row, game_account_id: String(row.game_account_id), account_id: String(row.account_id), generation: String(row.generation) })),
                    next: rows.length === request.arguments.limit ? rows.at(-1).request_id : null };
            }
            return { version: 1, request_id: request.request_id, status: 'success', result };
        }
        const response = await this.models.sequelize.transaction(async transaction => {
            const args = request.arguments, gameWhere = { game_account_id: request.game_account_id };
            const outcomeWhere = { realm_uid: request.realm.realm_uid, request_id: request.request_id };
            const hash = fingerprint(request);
            // Atomic materialization without overwriting an existing journal or
            // session; explicit FOR UPDATE locks serialize all following work.
            await this.models.RealmRPCOutcome.bulkCreate([{ ...outcomeWhere, fingerprint: hash }], { updateOnDuplicate: ['request_id'], transaction });
            const old = await this.models.RealmRPCOutcome.findOne({ where: outcomeWhere, transaction, lock: transaction.LOCK.UPDATE, raw: true });
            if (old.fingerprint !== hash) { throw new Failure('IDEMPOTENCY_CONFLICT'); }
            if (old.response !== null) { return json(old.response); }
            if (Date.parse(request.deadline) <= this.clock()) { throw new Failure('DEADLINE_EXPIRED'); }
            await this.models.GameAccountSession.bulkCreate([gameWhere], { updateOnDuplicate: ['game_account_id'], transaction });
            const session = await this.models.GameAccountSession.findOne({ where: gameWhere, transaction, lock: transaction.LOCK.UPDATE, raw: true });
            let result, policy;
            const recovery = ['state.commit', 'state.abort'].includes(request.operation);
            if (recovery) { result = await this.recover(request, session, transaction); }
            else {
                policy = await this.authorize(request, transaction);
                if (session.pending_request_id && !['state.append', 'state.seal'].includes(request.operation)) { throw new Failure('MUTATION_RECOVERY_REQUIRED', true); }
            }
            if (!recovery && request.operation === 'session.open') {
                const same = session.session_id === request.session_id && session.realm_uid === request.realm.realm_uid &&
                    session.pod_uid === request.realm.pod_uid && session.instance_id === request.realm.instance_id;
                const generation = same ? String(session.generation) : String(BigInt(session.generation) + 1n);
                if (BigInt(generation) > 9223372036854775807n) { throw new Failure('GENERATION_EXHAUSTED'); }
                await this.models.GameAccountSession.update({ generation, session_id: request.session_id, realm_uid: request.realm.realm_uid,
                    pod_uid: request.realm.pod_uid, instance_id: request.realm.instance_id }, { where: gameWhere, transaction });
                result = { generation, policy };
            } else if (!recovery) {
                if (String(session.generation) !== request.generation || session.session_id !== request.session_id ||
                    session.realm_uid !== request.realm.realm_uid || session.pod_uid !== request.realm.pod_uid || session.instance_id !== request.realm.instance_id) { throw new Failure('STALE_SESSION'); }
                if (request.operation === 'account.policy') { result = policy; }
                else if (request.operation === 'client.join') { result = await require('./handoff').issue(this, request, policy, transaction); }
                else if (request.operation === 'account.restore-policy') {
                    const row = await this.models.AccountRestoration.findByPk(policy.account_id, { transaction, raw: true });
                    result = { last_restore: Number(row?.last_restore || 0) };
                }
                else if (request.operation === 'state.read') {
                    const rows = await this.models.GameAccountState.findAll({ where: { ...gameWhere, domain: args.domain, entity_key: { [Op.gt]: args.after } },
                        attributes: ['entity_key', 'revision', 'value'], order: [['entity_key', 'ASC']], limit: args.limit, transaction, raw: true });
                    result = { items: rows.map(row => ({ key: row.entity_key, revision: String(row.revision), value: json(row.value) })), next: rows.length === args.limit ? rows.at(-1).entity_key : null };
                } else if (request.operation === 'state.put') { result = await this.put(request.game_account_id, args, transaction, request.realm.realm_uid); }
                else if (['state.begin', 'state.prepare'].includes(request.operation)) {
                    const staging = request.operation === 'state.begin';
                    if (!staging) {
                        for (const change of args.changes) { await this.checkRevision(request.game_account_id, change, transaction); }
                        await this.reserveRestoration(args.changes, policy.account_id, request.realm.realm_uid, request.request_id, transaction);
                    }
                    await this.models.GameAccountReservation.create({ ...outcomeWhere, ...gameWhere, account_id: policy.account_id, session_id: request.session_id,
                        generation: request.generation, pod_uid: request.realm.pod_uid, instance_id: request.realm.instance_id, changes: staging ? [] : args.changes,
                        status: staging ? 'staging' : 'prepared', expected_changes: staging ? args.change_count : 0, expected_chunks: staging ? args.chunk_count : 0 }, { transaction });
                    await this.models.GameAccountSession.update({ pending_request_id: request.request_id }, { where: gameWhere, transaction });
                    result = { reservation_id: request.request_id };
                } else if (['state.append', 'state.seal'].includes(request.operation)) { result = await this.staged(request, session, transaction); }
                else if (request.operation === 'characters.read') {
                    const counts = await this.models.GameAccountCharacters.findAll({ where: gameWhere, attributes: ['realm_uid', 'character_count'], limit: 4097, transaction, raw: true });
                    if (counts.length > 4096) { throw new Failure('CHARACTER_COUNTS_LIMIT'); }
                    const byRealm = new Map(counts.map(row => [row.realm_uid, Number(row.character_count)]));
                    const items = (await this.realmDirectory.rows()).filter(row => row.expansion === policy.expansion && row.realm_id > args.after && byRealm.has(row.realm_uid))
                        .sort((a, b) => a.realm_id - b.realm_id).slice(0, args.limit)
                        .map(row => ({ realm_id: Number(row.realm_id), region: Number(row.region), battlegroup: Number(row.battlegroup), count: byRealm.get(row.realm_uid) }));
                    result = { items, next: items.length === args.limit ? items.at(-1).realm_id : null };
                } else if (request.operation === 'characters.summary') {
                    await this.models.GameAccountCharacters.upsert({ ...gameWhere, realm_uid: request.realm.realm_uid, character_count: args.count, last_character: args.last_character }, { transaction });
                    result = { count: args.count };
                } else { throw new Failure('UNSUPPORTED_OPERATION'); }
            }
            const response = { version: 1, request_id: request.request_id, status: 'success', result };
            await this.models.RealmRPCOutcome.update({ response }, { where: outcomeWhere, transaction });
            return response;
        });
        return request.operation === 'client.join' ? require('./handoff').hydrate(this, request, response) : response;
    }
}
module.exports = RealmService;
