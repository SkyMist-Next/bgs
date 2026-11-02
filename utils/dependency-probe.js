'use strict';

const { deadline } = require('./deadline');

function dependencyProbe(operation, { timeout = 2000, cacheTime = 1000 } = {}) {
    let pending;
    let checked = -Infinity;
    let cached = false;
    return () => {
        if (pending) { return pending; }
        if (Date.now() - checked < cacheTime) { return Promise.resolve(cached); }
        // Invoke synchronously, but turn synchronous failures into probe failures.
        let underlying;
        try { underlying = Promise.resolve(operation()); }
        catch (error) { underlying = Promise.reject(error); }
        const result = deadline(underlying, timeout, 'Dependency probe timed out')
            .then(() => true, () => false)
            .then(healthy => { cached = healthy; checked = Date.now(); return healthy; });
        pending = result;
        // A timeout must not release the slot of a still-running probe.
        void Promise.allSettled([underlying, result]).then(() => { pending = undefined; });
        return result;
    };
}

function readiness({ store, sequelize, isStarted, probeTimeout = 2000 }) {
    const probe = dependencyProbe(async () => {
        const results = await Promise.allSettled([store.probe ? store.probe() : store.ping(), sequelize.authenticate()]);
        if (results.some(result => result.status === 'rejected')) { throw new Error('Dependency unavailable'); }
    }, { timeout: probeTimeout });
    return async () => isStarted() && store.healthy && await probe() && isStarted() && store.healthy;
}

module.exports = { dependencyProbe, readiness };
