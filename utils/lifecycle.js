'use strict';

function deadline(promise, milliseconds, message) {
    let timer;
    return Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]).finally(() => clearTimeout(timer));
}

function readiness({ store, sequelize, isStarted, probeTimeout = 2000 }) {
    let pending;
    let checked = 0;
    let cached = false;
    return async () => {
        if (!isStarted() || !store.healthy) { return false; }
        if (pending) { return pending; }
        if (Date.now() - checked < 1000) { return cached; }
        // Retain the coalesced probe until both underlying operations finish, even
        // after returning a timeout. A stuck SQL probe must not build a new queue.
        const probes = Promise.allSettled([store.ping(), sequelize.authenticate()]);
        pending = deadline(probes, probeTimeout, 'Readiness timed out')
            .then(results => results.every(result => result.status === 'fulfilled'), () => false)
            .then(result => { cached = result; checked = Date.now(); return result; });
        probes.then(() => { pending = undefined; });
        return pending;
    };
}

function lifecycle({ logger, stop, close, force, exit = code => process.exit(code), drainTimeout = 10000, forceTimeout = 1000 }) {
    let stopping = false;
    let task;
    const shutdown = (error) => {
        if (task) { return task; }
        stopping = true;
        if (error) { logger.error(error); }
        task = (async () => {
            let failed = Boolean(error);
            try {
                await deadline((async () => { await stop(); await close(); })(), drainTimeout, 'Shutdown drain timed out');
            }
            catch (cause) { failed = true; logger.error(cause); }
            finally {
                // Force close also cancels resources still opening during partial startup.
                try { await deadline(Promise.resolve().then(force), forceTimeout, 'Resource close timed out'); }
                catch { failed = true; }
                exit(failed ? 1 : 0);
            }
        })();
        return task;
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.on('unhandledRejection', error => { void shutdown(error); });
    return { shutdown, get stopping() { return stopping; } };
}

module.exports = { deadline, readiness, lifecycle };
