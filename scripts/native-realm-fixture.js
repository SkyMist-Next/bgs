'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createClient } = require('redis');
const { ticketKey, leaseKey } = require('../realm/sessions');

function run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', error = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
        child.stdout.on('data', value => { output += value; if (output.length > 65536) { child.kill('SIGKILL'); } });
        child.stderr.on('data', value => { error += value; if (error.length > 65536) { child.kill('SIGKILL'); } });
        child.on('error', cause => { clearTimeout(timer); reject(cause); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) { resolve(output.trim()); }
            else {
                const diagnostic = (output + error).trim();
                const code = /^[A-Z_]+$/.test(diagnostic) ? ': ' + diagnostic : '';
                reject(new Error('Owned native fixture failed: ' + args[0] + code));
            }
        });
    });
}
async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
module.exports = async function nativeFixture({ redis, sessions, owner, record, port, image, database, sql }) {
    const token = crypto.randomUUID();
    const name = 'skymist-native-admission-' + token;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), name));
    const ticket = crypto.randomBytes(20).toString('hex');
    const cancelTicket = crypto.randomBytes(20).toString('hex');
    const secondTicket = crypto.randomBytes(20).toString('hex');
    const secondID = (BigInt(owner.game_account_id) + 10000000000n).toString();
    const username = 'realm-' + owner.realm_uid;
    const password = 'local-validation-only';
    const sentinelPort = await freePort();
    const label = 'skymist.native-admission-fixture=' + token;
    let sentinel, outcome, failure;
    let cleanupFailed = false;
    try {
        const redisImage = await run(['inspect', 'skymist-legion-redis-validation', '--format', '{{.Image}}']);
        await redis.sendCommand(['ACL', 'SETUSER', username, 'reset', 'on', '>' + password, '-@all',
            '~/skymist/v1/realms/' + owner.realm_uid + '/*', '~/skymist/v1/sessions/*',
            ...['ping', 'role', 'select', 'get', 'watch', 'unwatch', 'multi', 'exec', 'discard', 'set', 'del', 'expire', 'pexpiretime'].map(command => '+' + command)]);
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        await fs.writeFile(path.join(directory, 'sentinel.conf'), 'bind 127.0.0.1\nport ' + sentinelPort + '\nprotected-mode yes\n' +
            'sentinel monitor fixture 127.0.0.1 ' + port('REALM_TEST_REDIS_PORT') + ' 1\nuser default off\n' +
            'user ' + username + ' on #' + hash + ' -@all +ping +sentinel|get-master-addr-by-name\n', { mode: 0o600 });
        await run(['run', '-d', '--name', name, '--label', label, '--network', 'host', '--user', process.getuid() + ':' + process.getgid(),
            '--memory', '128m', '--cpus', '1', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '-v', directory + ':/fixture', '--entrypoint', 'redis-sentinel', redisImage, '/fixture/sentinel.conf']);
        sentinel = createClient({ url: 'redis://127.0.0.1:' + sentinelPort, username, password,
            disableOfflineQueue: true, socket: { reconnectStrategy: false, connectTimeout: 500 } });
        sentinel.on('error', () => {});
        const deadline = Date.now() + 10000;
        while (!sentinel.isReady && Date.now() < deadline) {
            try { await sentinel.connect(); }
            catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        assert(sentinel.isReady, 'Owned Sentinel did not start');
        await sessions.issue(ticket, record);
        await sessions.issue(cancelTicket, record);
        await sql.getQueryInterface().bulkInsert('game_accounts', [{ id: secondID, account_id: owner.account_id, region: 1, expansion: 6, program: 'WoW' }]);
        await sessions.issue(secondTicket, { ...record, game_account_id: secondID });
        const config = { namespace: owner.namespace, realm_uid: owner.realm_uid, pod_uid: owner.pod_uid,
            instance_id: owner.instance_id, game_account_id: owner.game_account_id, account_id: owner.account_id,
            build: owner.build, ticket, cancel_ticket: cancelTicket, second_ticket: secondTicket, second_game_account_id: secondID,
            username, password, sentinel_port: sentinelPort, amqp_port: port('REALM_TEST_AMQP_PORT'),
            database, db_port: port('REALM_TEST_DB_PORT') };
        await fs.writeFile(path.join(directory, 'client.json'), JSON.stringify(config), { mode: 0o600 });
        const output = await run(['run', '--rm', '--name', name + '-client', '--label', label, '--network', 'host',
            '--user', process.getuid() + ':' + process.getgid(), '--memory', '256m', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '-v', path.join(directory, 'client.json') + ':/fixture/client.json:ro',
            '--entrypoint', '/out/realm_admission_live', image, '/fixture/client.json']);
        assert(output.includes('Native admission, fresh BGS policy'), 'Native fixture did not confirm admission');
        assert(output.includes('Native shared-state save, rollback, uncertain commit'), 'Native fixture did not confirm save recovery');
        assert(output.includes('Native two-account inventory commit, rollback and lost acknowledgement'), 'Native fixture did not confirm aggregate saves');
        assert(output.includes('Native startup recovery, marker identity checks'), 'Native fixture did not confirm startup recovery');
        assert(output.includes('Native authorized startup gate and periodic SQL ownership loss'), 'Native fixture did not confirm startup ownership');
        assert.equal(await redis.exists(leaseKey(owner.game_account_id)), 0, 'Native logout left its lease behind');
        assert.equal(await redis.exists(leaseKey(secondID)), 0, 'Native aggregate participant left its lease behind');
        outcome = 'passed';
    } catch (error) {
        failure = error;
    } finally {
        await sentinel?.close().catch(() => {});
        try {
            const raw = await redis.get(leaseKey(owner.game_account_id));
            if (raw && JSON.parse(raw).realm_uid === owner.realm_uid) { await sessions.update(JSON.parse(raw), 'release'); }
            await redis.del(ticketKey(owner.realm_uid, ticket));
            await redis.del(ticketKey(owner.realm_uid, cancelTicket));
            const other = await redis.get(leaseKey(secondID));
            if (other && JSON.parse(other).realm_uid === owner.realm_uid) { await sessions.update(JSON.parse(other), 'release'); }
            await redis.del(ticketKey(owner.realm_uid, secondTicket));
            await redis.sendCommand(['ACL', 'DELUSER', username]);
        } catch { cleanupFailed = true; }
        for (const container of [name + '-client', name]) {
            let info;
            try { info = JSON.parse(await run(['inspect', container]))[0]; }
            catch { continue; }
            try {
                assert.equal(info.Config.Labels['skymist.native-admission-fixture'], token);
                await run(['rm', '-fv', container]);
            } catch { cleanupFailed = true; }
        }
        try { await fs.rm(directory, { recursive: true, force: true }); }
        catch { cleanupFailed = true; }
    }
    if (failure) { throw failure; }
    if (cleanupFailed) { throw new Error('Owned native Redis fixture cleanup failed'); }
    return outcome;
};
