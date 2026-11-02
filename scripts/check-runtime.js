'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const microtime = require('microtime');
const createDatabase = require('../models');
const Service = require('../services/service');

async function checkRuntime() {
    for (const name of Object.keys(require('../package.json').dependencies)) {
        require(name);
    }
    const hash = await bcrypt.hash('native-addon-check', 4);
    assert.equal(await bcrypt.compare('native-addon-check', hash), true);
    assert.ok(Math.abs(microtime.now() - Date.now() * 1000) < 1000000);
    const db = createDatabase({ dialect: 'mysql', database: 'check', username: 'check', password: '' }, { debug() {} });
    assert.equal(db.GameAccount.build({ id: '9007199254740993', program: 'WoW', region: 2 }).entityId.low.toString(), '9007199254740993');
    await db.sequelize.close();
    assert.equal(new Service('ConnectionService', 'proto/bgs/low/pb/client/connection_service.proto', { logger: { error() {} } }).getServiceHash(), 0x65446991);
    console.log(`Runtime checks passed: ${process.version}; native addons, dependencies, models, protobuf`);
}

checkRuntime().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
