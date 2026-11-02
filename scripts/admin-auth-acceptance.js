'use strict';
const fs = require('node:fs');
const { once } = require('node:events');
const createDatabase = require('../utils/database');
const createRestApp = require('../utils/rest-app');
async function main() {
    const config = JSON.parse(fs.readFileSync(process.env.ADMIN_TEST_CONFIG));
    if (!/^skymist_admin_test_[a-f0-9]{12}$/.test(config.database)) { throw new Error('Not an isolated fixture database'); }
    const logger = { debug() {}, info() {}, error() {} };
    const models = createDatabase({ ...config, username: config.user, dialect: 'mysql', logging: false }, logger);
    let server;
    try {
        const store = { getLoginTicket: async () => ({ ticket: 'fixture', program: 'WoW', address: '192.0.2.1' }), authorizeLoginTicket: async () => {} };
        server = createRestApp({ models, store, logger, isReady: () => true }).listen(0, '127.0.0.1');
        await once(server, 'listening');
        const login = async () => (await fetch(`http://127.0.0.1:${server.address().port}/bnetserver/login/fixture`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs: [
                { input_id: 'account_name', value: 'Fixture@Example.test' }, { input_id: 'password', value: 'python-created-password' }
            ] })
        })).json();
        require('node:assert/strict').equal((await login()).authentication_state, 'DONE');
        await models.Account.update({ isBanned: true, banExpiresAt: null }, { where: { email: 'Fixture@Example.test' } });
        require('node:assert/strict').equal((await login()).authentication_state, 'LOGIN');
        await models.Account.update({ banExpiresAt: new Date('2020-01-01') }, { where: { email: 'Fixture@Example.test' } });
        require('node:assert/strict').equal((await login()).authentication_state, 'DONE');
        await models.Account.update({ isSuspended: true }, { where: { email: 'Fixture@Example.test' } });
        require('node:assert/strict').equal((await login()).authentication_state, 'LOGIN');
    }
    finally {
        if (server) { await new Promise(resolve => server.close(resolve)); }
        await models.sequelize.close();
    }
}
if (require.main === module) { main().catch(() => { console.error('BGS authentication acceptance failed'); process.exitCode = 1; }); }
