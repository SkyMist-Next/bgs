'use strict';
const { Failure } = require('./contract');

// The native cross-schema commit stages both summaries. Only an authenticated
// current source/destination process can publish that retained operation.
module.exports = async function publish(service, request) {
    const realm = await service.authorizeRealm(request);
    if (Date.parse(request.deadline) <= service.clock()) { throw new Failure('DEADLINE_EXPIRED'); }
    const result = await service.models.sequelize.transaction(async transaction => {
        const process = await service.models.RealmProcessOwner.findByPk(realm.realm_uid, { transaction, raw: true });
        if (!realm.available || realm.pod_uid !== request.realm.pod_uid || realm.instance_id !== request.realm.instance_id ||
            !process || process.instance_id !== request.realm.instance_id) { throw new Failure('PROCESS_OWNERSHIP_LOST'); }
        const replacements = { operation: request.arguments.operation_id, realm: realm.realm_uid, namespace: request.realm.namespace };
        const [operations] = await service.models.sequelize.query(`SELECT o.phase,o.plan_hash,r.owner_epoch,
            s.realm_uid source_uid,d.realm_uid destination_uid FROM guild_transfer_operation o
            JOIN guild_service_realm s ON s.realm_id=o.source_realm
            JOIN guild_service_realm d ON d.realm_id=o.destination_realm
            JOIN guild_service_realm r ON r.realm_uid=:realm AND r.realm_id IN(o.source_realm,o.destination_realm)
            WHERE o.operation_id=:operation AND s.namespace=:namespace AND d.namespace=:namespace
            AND s.realm_uid=o.source_uid AND d.realm_uid=o.destination_uid
            AND s.installation_id=d.installation_id AND s.database_service_id=d.database_service_id FOR UPDATE`,
        { replacements, transaction });
        const operation = operations[0];
        if (!operation || operation.plan_hash !== request.arguments.plan_hash || operation.owner_epoch !== request.arguments.epoch ||
            !['committed', 'publishing', 'complete'].includes(operation.phase)) { throw new Failure('GUILD_OPERATION_CHANGED'); }
        const [rows] = await service.models.sequelize.query(`SELECT p.*,r.realm_uid FROM guild_transfer_publication p
            JOIN guild_service_realm r ON r.realm_id=p.realm_id WHERE p.operation_id=:operation
            ORDER BY p.game_account_id,p.realm_id FOR UPDATE`, { replacements, transaction });
        const expected = new Set([operation.source_uid, operation.destination_uid]);
        if (rows.length !== expected.size || new Set(rows.map(row => row.realm_uid)).size !== expected.size ||
            rows.some(row => !expected.has(row.realm_uid)) || new Set(rows.map(row => String(row.game_account_id))).size !== 1) {
            throw new Failure('GUILD_PUBLICATION_INCOMPLETE');
        }
        if (rows.every(row => Number(row.published_at) > 0)) { return { published: true }; }
        if (rows.some(row => Number(row.published_at) > 0)) { throw new Failure('GUILD_PUBLICATION_INCONSISTENT'); }
        const account = String(rows[0].game_account_id), where = { game_account_id: account };
        await service.models.GameAccountSession.bulkCreate([where], { updateOnDuplicate: ['game_account_id'], transaction });
        const session = await service.models.GameAccountSession.findOne({ where, transaction, lock: transaction.LOCK.UPDATE, raw: true });
        if (session.pending_request_id) { throw new Failure('MUTATION_RECOVERY_REQUIRED', true); }
        const generation = BigInt(session.generation) + 1n;
        if (generation > 9223372036854775807n) { throw new Failure('GENERATION_EXHAUSTED'); }
        // Invalidates any character-select cache admitted before relocation.
        // New session admission loads the newly published shared revisions.
        await service.models.GameAccountSession.update({ generation: String(generation) }, { where, transaction });
        for (const row of rows) {
            const old = await service.models.GameAccountState.findOne({ where: { ...where, domain: 'characters', entity_key: row.realm_uid },
                transaction, lock: transaction.LOCK.UPDATE, raw: true });
            await service.put(account, { domain: 'characters', key: row.realm_uid, revision: String(old?.revision ?? 0),
                value: { count: Number(row.character_count), last_character: row.last_character === null ? null : String(row.last_character) } }, transaction, row.realm_uid);
        }
        await service.models.sequelize.query('UPDATE guild_transfer_publication SET published_at=:now WHERE operation_id=:operation',
            { replacements: { ...replacements, now: Math.floor(service.clock() / 1000) }, transaction });
        return { published: true };
    });
    return { version: 1, request_id: request.request_id, status: 'success', result };
};
