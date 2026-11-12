'use strict';

const { Failure } = require('../realm/contract');
const { validatePresence } = require('./realm-contract');
const { id } = require('./wire');
const OWNER = ['account_id', 'game_account_id', 'session_id', 'generation', 'realm_uid', 'namespace', 'instance_id', 'pod_uid'];
const key = gameAccountId => '/skymist/v1/social/character/' + id(gameAccountId);

class WorldPresence {
    constructor(store, models) { this.store = store; this.models = models; }
    async publish(owner, args) {
        validatePresence(args);
        const leaseKey = '/skymist/v1/sessions/' + owner.game_account_id, presenceKey = key(owner.game_account_id);
        return this.store.transaction([leaseKey, presenceKey], async client => {
            const rawLease = await client.get(leaseKey);
            const lease = rawLease && JSON.parse(rawLease);
            if (!lease || !OWNER.every(field => lease[field] === owner[field])) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
            const raw = await client.get(presenceKey), current = raw && JSON.parse(raw);
            if (current && OWNER.every(field => current.owner[field] === owner[field]) && BigInt(current.sequence) >= BigInt(args.sequence)) {
                if (current.sequence !== args.sequence || JSON.stringify(current.character) !== JSON.stringify(args.character)) {
                    throw new Failure('STALE_PRESENCE');
                }
                return { commands: [], result: { sequence: args.sequence } };
            }
            const record = { owner, sequence: args.sequence, character: args.character, updatedAt: Date.now() };
            // Retain a withdrawal tombstone so a delayed earlier publication cannot resurrect a character.
            return { commands: [['SET', presenceKey, JSON.stringify(record), 'EX', '90']], result: { sequence: args.sequence } };
        });
    }
    async get(gameAccountId) {
        const [raw, lease] = await this.store.run(client => client.mGet([key(gameAccountId), '/skymist/v1/sessions/' + id(gameAccountId)]));
        if (!raw || !lease) { return null; }
        const record = JSON.parse(raw), current = JSON.parse(lease);
        if (!OWNER.every(field => record.owner[field] === current[field])) { return null; }
        if (this.models) {
            const process = await this.models.RealmProcessOwner.findByPk(current.realm_uid, { raw: true });
            if (!process || process.instance_id !== current.instance_id) { return null; }
        }
        return record;
    }
    async session(gameAccountId) {
        const raw = await this.store.run(client => client.get('/skymist/v1/sessions/' + id(gameAccountId)));
        if (!raw) { return null; }
        const owner = JSON.parse(raw);
        if (this.models) {
            const process = await this.models.RealmProcessOwner.findByPk(owner.realm_uid, { raw: true });
            if (!process || process.instance_id !== owner.instance_id) { return null; }
        }
        return owner;
    }
}
module.exports = WorldPresence;
