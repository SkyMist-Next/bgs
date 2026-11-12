'use strict';

const { createHash } = require('node:crypto');

// A recording stand-in for SocialSession, the seam social adapters use. Data
// fields are copied; every method records [name, ...args] into calls. Pass
// `methods` (an object, or a function of the session) to replace behavior.
function fakeSession(data, { context = null, calls = [], methods = {} } = {}) {
    const session = { ...data };
    const record = (name, ...args) => calls.push([name, ...args]);
    const request = () => { if (!context) { throw 0xA; } return context; };
    Object.assign(session, {
        async selectGame(gameAccountId) {
            record('selectGame', gameAccountId);
            if (session.gameAccountId && session.gameAccountId !== gameAccountId) { throw 0xA; }
            session.gameAccountId = gameAccountId;
            return session;
        },
        async selectedGame() { record('selectedGame'); throw 0xA; },
        async subscribe(...args) { request(); record('subscribe', ...args); return {}; },
        async unsubscribe(...args) { record('unsubscribe', ...args); },
        async blockForSession(accountId) { record('blockForSession', accountId); return true; },
        async unblockForSession(accountId) { record('unblockForSession', accountId); return false; },
        async sessionBlocks() { return []; },
        operationId() {
            const { header = {}, operation = '' } = request();
            return createHash('sha256').update(JSON.stringify([session.sessionKey, header.methodId, header.token, operation])).digest('hex');
        },
        async whisper(...args) { record('whisper', ...args); return false; }
    }, typeof methods === 'function' ? methods(session) : methods);
    return session;
}

module.exports = { fakeSession };
