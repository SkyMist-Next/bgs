'use strict';
const { Failure } = require('./contract');
module.exports = async function processPermit(service, request) {
    const args = request.arguments, realm = await service.authorizeRealm(request);
    if (Date.parse(request.deadline) <= service.clock()) { throw new Failure('DEADLINE_EXPIRED'); }
    const selected = row => row.desired_pod_uid === request.realm.pod_uid && row.desired_revision === args.revision &&
        row.build === args.build && row.expansion === args.expansion;
    if (request.operation === 'process.claim' && !selected(realm)) { throw new Failure('PROCESS_NOT_SELECTED'); }
    return service.models.sequelize.transaction(async transaction => {
        const uid = request.realm.realm_uid, instance = request.realm.instance_id;
        const ownerWhere = { realm_uid: uid }, permitWhere = { realm_uid: uid, instance_id: instance };
        await service.models.RealmProcessOwner.bulkCreate([ownerWhere], { updateOnDuplicate: ['realm_uid'], transaction });
        const active = await service.models.RealmProcessOwner.findOne({ where: ownerWhere, transaction, lock: transaction.LOCK.UPDATE, raw: true });
        let permit = await service.models.RealmProcessPermit.findOne({ where: permitWhere, transaction, raw: true });
        if (permit) {
            if (active.instance_id !== instance) { throw new Failure('PROCESS_OWNERSHIP_LOST'); }
            if (permit.pod_uid !== request.realm.pod_uid || permit.revision !== args.revision || Number(permit.build) !== args.build ||
                Number(permit.expansion) !== args.expansion || permit.epoch !== args.epoch ||
                (request.operation === 'process.claim' && permit.previous_epoch !== args.previous_epoch)) { throw new Failure('PROCESS_PERMIT_CONFLICT'); }
        } else {
            if (request.operation !== 'process.claim') { throw new Failure('PROCESS_OWNERSHIP_LOST'); }
            await service.models.RealmProcessPermit.create({ ...permitWhere, pod_uid: request.realm.pod_uid, revision: args.revision,
                build: args.build, expansion: args.expansion, previous_epoch: args.previous_epoch, epoch: args.epoch }, { transaction });
            await service.models.RealmProcessOwner.update({ instance_id: instance }, { where: ownerWhere, transaction });
            permit = args;
        }
        // Recheck current selection after obtaining the SQL serialization fence.
        const current = await service.authorizeRealm(request);
        if (request.operation === 'process.claim' && !selected(current)) { throw new Failure('PROCESS_NOT_SELECTED'); }
        return { version: 1, request_id: request.request_id, status: 'success',
            result: { epoch: permit.epoch, revision: permit.revision, build: Number(permit.build), expansion: Number(permit.expansion), draining: !selected(current) } };
    });
};
