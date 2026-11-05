'use strict';
const { WatchError } = require('redis');

// The caller owns an exclusive primary connection for this entire function.
// Retry only an aborted optimistic transaction, never an uncertain EXEC outcome.
async function watched(client, keys, decide, deadline = Date.now() + 2000) {
    for (let attempt = 0; attempt < 4; attempt++) {
        if (Date.now() >= deadline) { throw new Error('Redis transaction deadline exceeded'); }
        await client.watch(keys);
        try {
            const decision = await decide(client);
            if (Date.now() >= deadline) { throw new Error('Redis transaction deadline exceeded'); }
            const transaction = client.multi();
            for (const command of decision.commands) { transaction.sendCommand(command, { isReadonly: false }); }
            if (!decision.commands.length) { transaction.ping(); }
            await transaction.exec();
            return decision.result;
        } catch (error) {
            if (!(error instanceof WatchError)) { throw error; }
        } finally { await client.unwatch().catch(() => {}); }
    }
    throw new Error('Redis transaction contention limit exceeded');
}
module.exports = { watched };
