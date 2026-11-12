'use strict';

const { Failure } = require('../realm/contract');
const { validatePresence } = require('./realm-contract');
const { id } = require('./wire');
const { WorldSessionLeases, readLease, leaseKey, sameWorld } = require('../realm/sessions');
const key = gameAccountId => '/skymist/v1/social/character/' + id(gameAccountId);

class WorldPresence {
    constructor(store, models) { this.store = store; this.models = models; this.leases = new WorldSessionLeases(store, models); }
    async publish(owner, args) {
        validatePresence(args);
        const presenceKey = key(owner.game_account_id), leasePath = leaseKey(owner.game_account_id);
        return this.store.transaction([leasePath, presenceKey], async client => {
            let lease;
            try { lease = await readLease(client, owner.game_account_id); } catch { lease = null; }
            if (!lease || !sameWorld(lease, owner)) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
            const raw = await client.get(presenceKey), current = raw && JSON.parse(raw);
            if (current && sameWorld(current.owner, owner) && BigInt(current.sequence) >= BigInt(args.sequence)) {
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
        const [lease, raw] = await Promise.all([this.leases.live(gameAccountId), this.store.run(client => client.get(key(gameAccountId)))]);
        if (!lease || !raw) { return null; }
        const record = JSON.parse(raw);
        return sameWorld(record.owner, lease) ? record : null;
    }
    session(gameAccountId) { return this.leases.live(gameAccountId); }
}
module.exports = WorldPresence;
