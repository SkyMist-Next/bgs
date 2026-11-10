'use strict';
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const RealmService = require('../realm/service');

module.exports = async function acceptance(sql) {
    const models = { sequelize: sql, ...require('../models/realmgameplay')(sql, Sequelize.DataTypes) };
    const source = '11111111-1111-4111-8111-111111111111', destination = '22222222-2222-4222-8222-222222222222';
    const pod = '33333333-3333-4333-8333-333333333333', instance = '44444444-4444-4444-8444-444444444444';
    const account = '9007199254740993', operation = 'a'.repeat(32), hash = 'b'.repeat(64), epoch = 'c'.repeat(32);
    for (const [rid, uid] of [[1, source], [2, destination]]) {
        await sql.query(`INSERT INTO guild_service_realm(realm_id,realm_uid,namespace,installation_id,database_service_id,
            auth_schema,character_schema,owner_epoch,owner_connection,heartbeat,protocol_version)
            VALUES(:rid,:uid,'fixture',:installation,:service,'fixture',:schema,:epoch,1,1,4)`,
        { replacements: { rid, uid, installation: 'd'.repeat(32), service: 'e'.repeat(64), schema: 'realm' + rid, epoch } });
    }
    await sql.query(`INSERT INTO guild_transfer_operation(operation_id,plan_hash,service,source_realm,destination_realm,
        source_schema,destination_schema,source_guild,destination_guild,leader_guid,successor_guid,new_name,phase,created_at,source_uid,destination_uid)
        VALUES(:operation,:hash,'realm-transfer',1,2,'realm1','realm2',9,10,1,2,'Moved','committed',1,:source,:destination)`, { replacements: { operation, hash, source, destination } });
    await sql.query(`INSERT INTO guild_transfer_publication(operation_id,realm_id,game_account_id,character_count,last_character)
        VALUES(:operation,1,:account,0,NULL),(:operation,2,:account,1,10001)`, { replacements: { operation, account } });
    await models.RealmProcessOwner.create({ realm_uid: source, instance_id: instance });
    await models.GameAccountSession.create({ game_account_id: account, generation: '7', pending_request_id: pod });
    const realm = { realm_uid: source, namespace: 'fixture', available: true, pod_uid: pod, instance_id: instance };
    const service = new RealmService({ models, realmDirectory: { rows: async () => [realm] }, clock: () => 1900000000000 });
    const request = { version: 1, request_id: pod, operation: 'guild.publish', deadline: '2031-01-01T00:00:00Z', realm,
        game_account_id: '0', session_id: instance, generation: '0', arguments: { operation_id: operation, plan_hash: hash, epoch } };
    await assert.rejects(service.execute(request), /MUTATION_RECOVERY_REQUIRED/);
    assert.equal(String((await models.GameAccountSession.findByPk(account)).generation), '7');
    assert.equal(await models.GameAccountCharacters.count(), 0);
    await models.GameAccountSession.update({ pending_request_id: null }, { where: { game_account_id: account } });
    await sql.query('UPDATE guild_transfer_operation SET destination_uid=:source', { replacements: { source } });
    await assert.rejects(service.execute(request), /GUILD_OPERATION_CHANGED/);
    await sql.query('UPDATE guild_transfer_operation SET destination_uid=:destination', { replacements: { destination } });
    const put = service.put.bind(service);
    service.put = async (...args) => { if (args[3] === destination) { throw new Error('injected second-realm failure'); } return put(...args); };
    await assert.rejects(service.execute(request), /injected/);
    assert.equal(await models.GameAccountCharacters.count(), 0, 'both realms roll back together');
    assert.equal(String((await models.GameAccountSession.findByPk(account)).generation), '7');
    service.put = put;
    await assert.rejects(service.execute({ ...request, arguments: { ...request.arguments, epoch: 'f'.repeat(32) } }), /GUILD_OPERATION_CHANGED/);
    await assert.rejects(service.execute({ ...request, arguments: { ...request.arguments, plan_hash: 'f'.repeat(64) } }), /GUILD_OPERATION_CHANGED/);
    const results = await Promise.all([service.execute(request), service.execute({ ...request, request_id: instance })]);
    assert.ok(results.every(reply => reply.result.published));
    assert.equal(String((await models.GameAccountSession.findByPk(account)).generation), '8', 'duplicate publication invalidates caches once');
    const counts = await models.GameAccountCharacters.findAll({ order: [['realm_uid', 'ASC']], raw: true });
    assert.deepEqual(counts.map(row => [String(row.game_account_id), Number(row.character_count)]), [[account, 0], [account, 1]]);
    const revisions = await models.GameAccountState.findAll({ raw: true });
    assert.ok(revisions.every(row => String(row.revision) === '1'));
    // The fixture tables remain available for further independent acceptance.
};
