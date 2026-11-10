'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { QueryTypes } = require('sequelize');

function integer(value, zero = false) {
    const text = String(value);
    if (!/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > 9223372036854775807n || (!zero && text === '0')) {
        throw new Error('Invalid authenticator identity');
    }
    return text;
}
function aad(account, generation) {
    const ids = Buffer.alloc(16);
    ids.writeBigUInt64BE(BigInt(integer(account)), 0);
    ids.writeBigUInt64BE(BigInt(integer(generation)), 8);
    return Buffer.concat([Buffer.from('SkyMist/Authenticator/secret/v2'), ids]);
}
function loadKey(path) {
    if (!path) { return null; }
    const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o027) !== 0) { throw new Error('Invalid authenticator key file'); }
        return fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
}
function seal(secret, key, account, generation, nonce = crypto.randomBytes(12)) {
    if (secret.length !== 20 || key.length !== 32 || nonce.length !== 12) { throw new Error('Invalid authenticator material'); }
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(account, generation));
    return Buffer.concat([Buffer.from([2]), nonce, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
}
function open(envelope, key, account, generation) {
    if (!key || key.length !== 32 || !Buffer.isBuffer(envelope) || envelope.length !== 49 || envelope[0] !== 2) {
        throw new Error('Authenticator unavailable');
    }
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 13));
    cipher.setAAD(aad(account, generation));
    cipher.setAuthTag(envelope.subarray(33));
    const plain = cipher.update(envelope.subarray(13, 33));
    try { return Buffer.concat([plain, cipher.final()]); }
    finally { plain.fill(0); }
}
function codeAt(secret, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hash = crypto.createHmac('sha1', secret).update(counter).digest();
    const value = String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 100000000).padStart(8, '0');
    hash.fill(0);
    return value;
}
function matchCode(secret, code, now, lastStep) {
    if (typeof code !== 'string' || !/^[0-9]{8}$/.test(code) || !Number.isSafeInteger(now) || now < 0) { return null; }
    let accepted = null;
    const step = Math.floor(now / 30);
    for (const candidate of [step - 1, step, step + 1]) {
        if (candidate < 0) { continue; }
        const match = crypto.timingSafeEqual(Buffer.from(codeAt(secret, candidate)), Buffer.from(code));
        if (match && (lastStep === null || BigInt(candidate) > BigInt(lastStep))) { accepted = candidate; }
    }
    return accepted;
}
function metadata(account) {
    const state = Number(account.authenticatorState ?? 0);
    if (![0, 1, 2].includes(state)) { throw new Error('Invalid authenticator state'); }
    return {
        credentialVersion: integer(account.credentialVersion ?? '1'),
        authenticatorGeneration: integer(account.authenticatorGeneration ?? '0', true),
        authenticatorState: state
    };
}
function requireProof(account, proof, now = Date.now()) {
    const current = metadata(account);
    if (String(proof?.credentialVersion ?? '1') !== current.credentialVersion ||
        String(proof?.authenticatorGeneration ?? '0') !== current.authenticatorGeneration ||
        (current.authenticatorState === 2 && (!Number.isSafeInteger(Number(proof?.authenticatorVerifiedAt)) ||
            Number(proof.authenticatorVerifiedAt) <= 0 || Number(proof.authenticatorVerifiedAt) * 1000 > now))) {
        throw new Error('Authentication proof revoked');
    }
    return current;
}
function wireProof(record) {
    const proof = {
        credentialVersion: integer(record.credential_version ?? '1'),
        authenticatorGeneration: integer(record.authenticator_generation ?? '0', true),
        authenticatorVerifiedAt: record.authenticator_verified_at ?? 0
    };
    if (!Number.isSafeInteger(proof.authenticatorVerifiedAt) || proof.authenticatorVerifiedAt < 0) {
        throw new Error('Invalid authenticator proof');
    }
    return proof;
}
function sameProof(a, b) {
    const left = wireProof(a), right = wireProof(b);
    return Object.keys(left).every(key => left[key] === right[key]);
}
class Authenticator {
    constructor(models, key, clock = Date.now) { Object.assign(this, { models, key, clock }); }
    async verify(account, pending, code) {
        // Lock the parent before its enrollment, matching the administration lock order.
        // Returning a rejection commits the attempt counter; exceptions roll back.
        return this.models.sequelize.transaction(async transaction => {
            const current = await this.models.Account.findByPk(String(account.id), { transaction, lock: transaction.LOCK.UPDATE });
            const state = metadata(current);
            const now = Math.floor(this.clock() / 1000);
            if (state.authenticatorState !== 2 || state.credentialVersion !== pending.credentialVersion ||
                state.authenticatorGeneration !== pending.authenticatorGeneration || now >= Number(pending.expiresAt)) { return null; }
            const options = { transaction, replacements: { account: String(account.id) }, type: QueryTypes.SELECT };
            const [row] = await this.models.sequelize.query('SELECT * FROM account_authenticators WHERE account_id=:account FOR UPDATE', options);
            if (!row || String(row.generation) !== state.authenticatorGeneration) { throw new Error('Authenticator unavailable'); }
            if (Number(row.blocked_until) > now) { return null; }
            const secret = open(row.sealed_secret, this.key, account.id, row.generation);
            let step;
            try { step = matchCode(secret, code, now, row.last_step); }
            finally { secret.fill(0); }
            const failures = step === null ? (Number(row.failed_attempts) % 5) + 1 : 0;
            await this.models.sequelize.query(`UPDATE account_authenticators SET last_step=:step,
                failed_attempts=:failures,blocked_until=:blocked WHERE account_id=:account`, {
                transaction, replacements: { account: String(account.id), step: step ?? row.last_step, failures, blocked: failures === 5 ? now + 30 : 0 }
            });
            return step === null ? null : { ...state, authenticatorVerifiedAt: now };
        });
    }
}
module.exports = { integer, aad, loadKey, seal, open, codeAt, matchCode, metadata, requireProof, wireProof, sameProof, Authenticator };
