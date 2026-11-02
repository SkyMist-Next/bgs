'use strict';

const fs = require('node:fs/promises');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { validate } = require('../utils/tls-credentials');

async function main() {
    const { values } = parseArgs({ options: { cert: { type: 'string' }, key: { type: 'string' }, ca: { type: 'string' } } });
    if (!values.cert || !values.key || !values.ca) { throw new Error('Usage: npm run local:tls -- --cert FILE --key FILE --ca FILE'); }
    const [cert, key, ca] = await Promise.all([values.cert, values.key, values.ca].map(file => fs.readFile(file)));
    validate({ cert, key }, 'bgs.local');
    execFileSync('openssl', ['verify', '-purpose', 'sslserver', '-verify_hostname', 'bgs.local',
        '-CAfile', values.ca, '-untrusted', values.cert, values.cert], { stdio: 'ignore' });
    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'bgs-local-tls', namespace: 'bgs-test' },
        type: 'kubernetes.io/tls', data: { 'tls.crt': cert.toString('base64'), 'tls.key': key.toString('base64'), 'ca.crt': ca.toString('base64') } };
    const result = spawnSync('kubectl', ['--context', 'minikube', '--request-timeout=15s', '-n', 'bgs-test',
        'apply', '--server-side', '--field-manager=bgs-local-tls', '-f', '-'],
    { input: JSON.stringify(secret), stdio: ['pipe', 'ignore', 'ignore'], timeout: 30000 });
    if (result.error || result.status !== 0) { throw new Error('TLS Secret import failed; inspect minikube/bgs-test and Secret field ownership'); }
    console.log('Imported dev TLS credentials into minikube/bgs-test/bgs-local-tls');
}
if (require.main === module) { main().catch(() => { console.error('TLS import failed: check arguments, certificate chain, hostname, key, and cluster access'); process.exitCode = 1; }); }
