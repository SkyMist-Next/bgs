'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const BaseServer = require('../servers/base-server');
const { fixture } = require('./support/server-fixture');

test('health listener reports dependency readiness and closes on shutdown', async () => {
    const state = fixture({ healthPort: 18081 });
    const server = new BaseServer(state.options);
    try {
        await server.start();
        assert.equal((await fetch('http://127.0.0.1:18081/ready')).status, 200);
        state.store.healthy = false;
        assert.equal((await fetch('http://127.0.0.1:18081/ready')).status, 503);
        assert.equal((await fetch('http://127.0.0.1:18081/alive')).status, 200);
    } finally { await server.stop(); }
    await assert.rejects(fetch('http://127.0.0.1:18081/alive'));
});
