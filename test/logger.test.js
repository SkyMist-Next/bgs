'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const createLogger = require('../utils/logger');

test('Winston writes structured messages and error stacks with configured file options', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bgs-logger-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'service.log');
    const logger = createLogger({ filename, level: 'debug', maxsize: 4096, maxFiles: 3, tailable: true, json: true }, 'production');
    t.after(() => logger.close());
    const transport = logger.transports[0];
    assert.equal(transport.maxsize, 4096);
    assert.equal(transport.maxFiles, 3);
    assert.equal(transport.tailable, true);
    logger.debug('database query');
    logger.error(new Error('dependency failed'));
    const finished = once(logger, 'finish');
    logger.end();
    await finished;
    const lines = (await fs.readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines[0].message, 'database query');
    assert.equal(lines[0].level, 'debug');
    assert.ok(lines[0].timestamp);
    assert.equal(lines[1].message, 'dependency failed');
    assert.match(lines[1].stack, /Error: dependency failed\n\s+at /);
});

test('plain file formatting and development console retain debug output and stacks', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bgs-logger-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'plain.log');
    const logger = createLogger({ filename, level: 'error', json: false, timestamp: false }, 'development');
    t.after(() => logger.close());
    const consoleTransport = logger.transports.find(transport => transport.name === 'console');
    assert.equal(consoleTransport.level, 'debug');
    const output = [];
    // Capture the formatted Console transport output without writing to the test runner.
    t.mock.method(consoleTransport, 'log', (info, callback) => {
        output.push(info[Symbol.for('message')]);
        callback();
    });
    logger.debug('console debug');
    logger.error(new Error('plain error'));
    const finished = once(logger, 'finish');
    logger.end();
    await finished;
    assert.match(output[0], /debug.*console debug/);
    assert.match(output[1], /Error: plain error/);
    assert.match(await fs.readFile(filename, 'utf8'), /^error: Error: plain error\n\s+at /);
});
