'use strict';

// A small in-memory stand-in for RedisStore's run/transaction seams. It models
// string values with millisecond expiry on an injectable clock.
function memoryRedis({ clock = Date.now } = {}) {
    const values = new Map(), expiries = new Map();
    const live = key => {
        if (expiries.has(key) && expiries.get(key) <= clock()) { values.delete(key); expiries.delete(key); }
        return values.has(key);
    };
    const expire = (key, options = {}) => {
        if (options.EX !== undefined) { expiries.set(key, clock() + Number(options.EX) * 1000); }
        else if (options.PX !== undefined) { expiries.set(key, clock() + Number(options.PX)); }
        else if (options.PXAT !== undefined) { expiries.set(key, Number(options.PXAT)); }
        else if (!options.KEEPTTL) { expiries.delete(key); }
    };
    const client = {
        get: async key => live(key) ? values.get(key) : null,
        mGet: async keys => keys.map(key => live(key) ? values.get(key) : null),
        getEx: async (key, options) => {
            if (!live(key)) { return null; }
            expire(key, options);
            return values.get(key);
        },
        set: async (key, value, options = {}) => {
            const exists = live(key);
            if ((options.NX && exists) || (options.XX && !exists)) { return null; }
            values.set(key, String(value));
            expire(key, options);
            return 'OK';
        },
        del: async (...keys) => keys.flat().filter(key => live(key) && values.delete(key) && (expiries.delete(key) || true)).length,
        pTTL: async key => !live(key) ? -2 : expiries.has(key) ? expiries.get(key) - clock() : -1,
        exists: async key => Number(live(key))
    };
    const options = args => {
        const parsed = {};
        for (let i = 0; i < args.length; i++) {
            const flag = String(args[i]).toUpperCase();
            if (['EX', 'PX', 'PXAT'].includes(flag)) { parsed[flag] = args[++i]; } else { parsed[flag] = true; }
        }
        return parsed;
    };
    return {
        values, expiries, client, clock,
        run: operation => operation(client),
        async transaction(keys, decide) {
            const { commands = [], result } = await decide(client);
            for (const [command, key, ...args] of commands) {
                if (command === 'SET') { await client.set(key, args[0], options(args.slice(1))); }
                else if (command === 'DEL') { await client.del(key); }
                else if (command === 'EXPIRE') { if (live(key)) { expire(key, { EX: args[0] }); } }
                else { throw new Error('Unsupported transaction command ' + command); }
            }
            return result;
        }
    };
}
// Seeds one client session exactly as authentication stores it.
function seedSession(redis, connectionId, value, seconds = 300) {
    redis.values.set('/aurora/connections/' + connectionId, JSON.stringify(value));
    redis.expiries.set('/aurora/connections/' + connectionId, redis.clock() + seconds * 1000);
}
// Adapts a test's per-connection session lookup to the client-session storage seam.
function sessionClient(lookup, extra = {}) {
    const prefix = '/aurora/connections/';
    const read = async key => {
        if (!key.startsWith(prefix)) { return null; }
        const value = await lookup(key.slice(prefix.length));
        return value ? JSON.stringify(value) : null;
    };
    return { get: read, getEx: read, set: async () => 'OK', del: async () => 1, ...extra };
}
module.exports = { memoryRedis, seedSession, sessionClient };
