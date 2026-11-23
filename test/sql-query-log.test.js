'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const Sequelize = require('sequelize');
const BaseServer = require('../servers/base-server');
const openSqlQueryLog = require('../utils/sql-query-log');
const { fixture } = require('./support/server-fixture');

const trace = 'Executing (default): SELECT 1';

async function tempDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bgs-sql-log-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('runtime disables SQL tracing by default and flushes enabled traces only to the file', async t => {
    const filename = path.join(await tempDirectory(t), 'sequelize.log');
    t.mock.method(Sequelize.prototype, 'authenticate', async function () { this.log(trace); });
    for (const [env, enabled] of [[{}, false], [{ BGS_SQL_LOG_FILE: '' }, false], [{ BGS_SQL_LOG_FILE: filename }, true]]) {
        const state = fixture({ env, database: { dialect: 'mysql', database: 'bgs', logging: true } });
        delete state.options.factories.database;
        const applicationLogs = [];
        for (const level of ['debug', 'info', 'error']) {
            state.options.logger[level] = message => applicationLogs.push(message);
        }
        const server = new BaseServer(state.options);
        await server.start();
        assert.equal(typeof server.dependencies.models.sequelize.options.logging === 'function', enabled);
        assert.equal((await server.stop()).exitCode, 0);
        assert.ok(applicationLogs.includes('Server lifecycle: running'));
        assert.ok(!applicationLogs.some(message => message.includes(trace)));
        if (enabled) {
            const record = JSON.parse(await fs.readFile(filename, 'utf8'));
            assert.equal(record.message, trace);
            assert.ok(Number.isFinite(Date.parse(record.timestamp)));
            assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
        }
        else {
            await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
        }
    }
});

test('a full SQL log rotates and only the three newest archives are retained', async t => {
    const filename = path.join(await tempDirectory(t), 'sequelize.log');
    await fs.writeFile(filename, 'original');
    await fs.truncate(filename, 10 * 1024 * 1024);
    for (let index = 1; index <= 3; index++) {
        await fs.writeFile(`${filename}.${index}`, String(index));
    }
    const errors = [];
    const sink = openSqlQueryLog(filename, { error: message => errors.push(message) });
    sink.write(trace);
    await sink.close();
    assert.deepEqual(errors, []);
    assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).message, trace);
    assert.equal((await fs.stat(filename + '.1')).size, 10 * 1024 * 1024);
    assert.equal(await fs.readFile(filename + '.3', 'utf8'), '2');
    await assert.rejects(fs.stat(filename + '.4'), { code: 'ENOENT' });
});

test('a failing SQL log reports one diagnostic and does not prevent serving or stopping', async t => {
    const directory = await tempDirectory(t);
    t.mock.method(Sequelize.prototype, 'authenticate', async function () { this.log(trace); });
    const state = fixture({ env: { BGS_SQL_LOG_FILE: directory }, database: { dialect: 'mysql', database: 'bgs' } });
    delete state.options.factories.database;
    const errors = [];
    state.options.logger.error = message => errors.push(message);
    const server = new BaseServer(state.options);
    await server.start();
    assert.equal(await server.isReady(), true);
    assert.equal((await server.stop()).exitCode, 0);
    assert.deepEqual(errors, ['SQL query log file unavailable; query logging disabled']);
});
