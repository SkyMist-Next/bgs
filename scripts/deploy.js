'use strict';
/* eslint-disable n/no-process-exit -- Lease loss and deadlines must interrupt in-flight DDL. */

// Image-owned bootstrap and schema commands. Never print connection errors or secrets.
const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');
const Sequelize = require('sequelize');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = process.env;
const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount/';
const namespace = () => fs.readFileSync(serviceAccount + 'namespace', 'utf8');
function api(method, path, body) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: env.KUBERNETES_SERVICE_HOST, port: env.KUBERNETES_SERVICE_PORT,
            path, method, ca: fs.readFileSync(serviceAccount + 'ca.crt'),
            headers: { Authorization: 'Bearer ' + fs.readFileSync(serviceAccount + 'token', 'utf8'), 'Content-Type': 'application/json' },
            timeout: 5000 }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('API timeout')));
        req.end(body ? JSON.stringify(body) : undefined);
    });
}
async function bootstrap() {
    const path = '/api/v1/namespaces/' + namespace() + '/secrets';
    for (const entry of JSON.parse(env.SECRET_SPECS)) {
        const result = await api('GET', path + '/' + entry.name);
        if (result.status === 200) {
            if (!entry.keys.every(key => result.body.data?.[key] && Buffer.from(result.body.data[key], 'base64').length)) { throw new Error('Invalid existing secret'); }
            if (entry.username) {
                const url = new URL(Buffer.from(result.body.data.url, 'base64').toString());
                if (decodeURIComponent(url.username) !== entry.username || url.hostname !== env.DB_HOST ||
                    decodeURIComponent(url.pathname.slice(1)) !== env.DB_NAME ||
                    decodeURIComponent(url.password) !== Buffer.from(result.body.data.password, 'base64').toString()) {
                    throw new Error('Existing credentials do not match database settings');
                }
            }
            continue;
        }
        if (result.status !== 404) { throw new Error('Secret lookup failed'); }
        const values = Object.fromEntries(entry.keys.map(key => [key, crypto.randomBytes(32).toString('hex')]));
        if (entry.username) {
            values.username = entry.username;
            values.url = 'mysql://' + encodeURIComponent(entry.username) + ':' + encodeURIComponent(values.password) +
                '@' + env.DB_HOST + ':3306/' + encodeURIComponent(env.DB_NAME);
        }
        const created = await api('POST', path, { apiVersion: 'v1', kind: 'Secret',
            metadata: { name: entry.name, labels: { 'app.kubernetes.io/instance': env.RELEASE_NAME } }, stringData: values });
        if (![201, 409].includes(created.status)) { throw new Error('Secret creation failed'); }
    }
}
async function lock() {
    const base = '/apis/coordination.k8s.io/v1/namespaces/' + namespace() + '/leases';
    const path = base + '/' + env.MIGRATION_LOCK;
    const holder = crypto.randomUUID();
    const update = async acquire => {
        const old = await api('GET', path);
        if (![200, 404].includes(old.status)) { throw new Error('Lease lookup failed'); }
        const spec = old.body.spec || {};
        if (spec.holderIdentity && spec.holderIdentity !== holder &&
            Date.parse(spec.renewTime) + 60000 > Date.now()) { return false; }
        if (!acquire && spec.holderIdentity !== holder) { throw new Error('Lease lost'); }
        const body = { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
            metadata: { name: env.MIGRATION_LOCK, ...(old.status === 200 ? { resourceVersion: old.body.metadata.resourceVersion } : {}) },
            spec: { holderIdentity: holder, leaseDurationSeconds: 60, renewTime: new Date().toISOString().replace('Z', '000Z') } };
        const response = await api(old.status === 404 ? 'POST' : 'PUT', old.status === 404 ? base : path, body);
        if (![200, 201, 409].includes(response.status)) { throw new Error('Lease update failed'); }
        return [200, 201].includes(response.status);
    };
    while (!await update(true)) { await sleep(2000); }
    let stopped = false;
    const renew = async () => {
        while (!stopped) {
            await sleep(10000);
            if (stopped) { break; }
            try { if (!await update(false)) { process.exit(1); } }
            catch { process.exit(1); }
        }
    };
    void renew();
    return () => { stopped = true; };
}
async function schema(mode) {
    const sql = new Sequelize(env.DATABASE_URL, { logging: false, dialectOptions: { connectTimeout: 5000 }, pool: { max: 1 } });
    let release;
    try {
        while (true) {
            try { await sql.authenticate(); break; } catch { await sleep(2000); }
        }
        const files = fs.readdirSync(require('node:path').join(__dirname, '../migrations')).filter(name => name.endsWith('.js')).sort();
        if (mode === 'wait') {
            while (true) {
                try {
                    const [rows] = await sql.query('SELECT name FROM SequelizeMeta');
                    if (files.every(name => rows.some(row => row.name === name))) { return; }
                } catch { /* Database and migrations may not exist yet. */ }
                await sleep(2000);
            }
        }
        release = await lock();
        await sql.query('CREATE TABLE IF NOT EXISTS SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY)');
        await sql.query('CREATE TABLE IF NOT EXISTS BgsMigrationJournal (name VARCHAR(255) NOT NULL PRIMARY KEY, complete BOOLEAN NOT NULL DEFAULT FALSE)');
        const [done] = await sql.query('SELECT name FROM SequelizeMeta');
        for (const name of files) {
            if (done.some(row => row.name === name)) { continue; }
            const [journal] = await sql.query('SELECT name FROM BgsMigrationJournal WHERE name = ?', { replacements: [name] });
            if (journal.length) { throw new Error('Incomplete migration requires recovery'); }
            await sql.query('INSERT INTO BgsMigrationJournal (name) VALUES (?)', { replacements: [name] });
            await require('../migrations/' + name).up(sql.getQueryInterface(), Sequelize);
            await sql.transaction(async transaction => {
                await sql.query('INSERT INTO SequelizeMeta (name) VALUES (?)', { replacements: [name], transaction });
                await sql.query('UPDATE BgsMigrationJournal SET complete = TRUE WHERE name = ?', { replacements: [name], transaction });
            });
            console.log('Applied migration ' + name);
        }
    } finally { release?.(); await sql.close(); }
}
async function main() {
    const mode = process.argv[2];
    const timer = setTimeout(() => process.exit(1), Number(env.DEPLOY_TIMEOUT_MS || 900000));
    timer.unref();
    try {
        if (mode === 'bootstrap') { await bootstrap(); }
        else if (['migrate', 'wait'].includes(mode)) { await schema(mode); }
        else { throw new Error('Unknown deployment command'); }
    } catch { console.error('Deployment command failed; inspect resource readiness and migration journal.'); process.exitCode = 1; }
}
if (require.main === module) { void main(); }
module.exports = { bootstrap, schema };
