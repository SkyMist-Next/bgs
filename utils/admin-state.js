'use strict';
const ipaddr = require('ipaddr.js');

function canonicalIP(value) {
    if (typeof value !== 'string' || value.includes('%') || !require('node:net').isIP(value)) {
        throw new Error('Invalid exact IP address');
    }
    return ipaddr.process(value).toString();
}
function trustedPeer(address, ranges) {
    const ip = ipaddr.process(canonicalIP(address));
    return ranges.some(range => {
        const [network, prefix] = ipaddr.parseCIDR(range);
        return network.kind() === ip.kind() && ip.match(network, prefix);
    });
}
function banned(record, now = Date.now()) {
    return Boolean(record?.isBanned && (!record.banExpiresAt || new Date(record.banExpiresAt).getTime() > now));
}
function blocked(record, now = Date.now()) { return !record || Boolean(record.isSuspended) || banned(record, now); }
async function checkIP(models, address, now = Date.now()) {
    if (!models.ipBansEnabled) { return; }
    const row = await models.IPBan.findOne({ where: { address: canonicalIP(address) } });
    if (row && (!row.expiresAt || new Date(row.expiresAt).getTime() > now)) { throw 0xA; }
}
async function principal(models, store, context) {
    const supplied = context?.identity;
    if (!supplied?.connectionId || !supplied.address) { throw 0xA; }
    const value = await store.getConnectionIdentity(supplied.connectionId);
    if (!value || value.address !== supplied.address) { throw 0xA; }
    await checkIP(models, value.address);
    const account = await models.Account.findByPk(value.accountId);
    if (blocked(account)) { throw 0xA; }
    return { ...value, connectionId: supplied.connectionId };
}
async function gameAccount(models, owner, id) {
    if (!/^[1-9][0-9]{0,18}$/.test(String(id))) { throw 0xA; }
    const account = await models.GameAccount.findByPk(String(id));
    if (blocked(account) || String(account.accountId) !== owner.accountId) { throw 0xA; }
    return account;
}
async function privilege(models, id, realmUid) {
    // Presence of an override (including zero) wins over the global row.
    if (realmUid) {
        const override = await models.GameAccountPrivilege.findOne({ where: { gameAccountId: id, realmUid } });
        if (override) { return override.level; }
    }
    const global = await models.GameAccountPrivilege.findOne({ where: { gameAccountId: id, realmUid: '' } });
    return global?.level ?? 0;
}
module.exports = { privilege, canonicalIP, trustedPeer, banned, blocked, checkIP, principal, gameAccount };
