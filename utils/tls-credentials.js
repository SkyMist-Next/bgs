'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const tls = require('node:tls');

function validate(credentials, hostname) {
    const certificate = new crypto.X509Certificate(credentials.cert);
    if (certificate.ca || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
        throw new Error('TLS certificate must be a current server certificate');
    }
    if (certificate.keyUsage && !certificate.keyUsage.includes('1.3.6.1.5.5.7.3.1')) {
        throw new Error('TLS certificate does not permit server authentication');
    }
    if (hostname && !certificate.checkHost(hostname, { subject: 'never' })) {
        throw new Error('TLS certificate hostname mismatch');
    }
    if (!certificate.checkPrivateKey(crypto.createPrivateKey(credentials.key))) {
        throw new Error('TLS certificate and key do not match');
    }
    tls.createSecureContext(credentials);
    return certificate;
}

class TlsCredentials {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.stopped = false;
    }

    async read() {
        if (this.config.tls) { return this.config.tls; }
        const files = [this.config.tlsCertFile || 'certs/tls.crt', this.config.tlsKeyFile || 'certs/tls.key'];
        const before = await Promise.all(files.map(file => fs.realpath(file)));
        const [cert, key] = await Promise.all(before.map(file => fs.readFile(file)));
        const after = await Promise.all(files.map(file => fs.realpath(file)));
        if (before.some((file, index) => file !== after[index])) { throw new Error('TLS files changed during read'); }
        return { cert, key };
    }

    async load() {
        const credentials = await this.read();
        const certificate = validate(credentials, this.config.tlsServerName);
        return { credentials, certificate, digest: crypto.createHash('sha256').update(credentials.cert).update(credentials.key).digest('hex') };
    }

    async initialize() {
        this.active = await this.load();
        return this.active.credentials;
    }

    valid() { return Boolean(this.active && Date.parse(this.active.certificate.validTo) > Date.now()); }

    start(server) {
        this.server = server;
        if (!this.config.tls) { this.schedule(); }
    }

    schedule() {
        if (this.stopped) { return; }
        this.timer = setTimeout(async () => { await this.reload(); this.schedule(); }, this.config.tlsReloadIntervalMs ?? 30000);
        this.timer.unref();
    }

    async reload() {
        try {
            const candidate = await this.load();
            if (this.stopped) { return; }
            if (candidate.digest !== this.active.digest) {
                this.server.setSecureContext(candidate.credentials);
                this.active = candidate;
                this.logger?.info('TLS certificate activated: ' + candidate.certificate.fingerprint256 + ' expires ' + candidate.certificate.validTo);
            }
            this.failed = false;
        }
        catch {
            if (!this.stopped && !this.failed) { this.logger?.error('TLS credential reload rejected; retaining active certificate'); }
            this.failed = true;
        }
    }

    stop() { this.stopped = true; clearTimeout(this.timer); }
}

module.exports = { TlsCredentials, validate };
