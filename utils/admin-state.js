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
async function checkIP(models, address, now = Date.now(), options = {}) {
    if (!models.ipBansEnabled) { return; }
    const row = await models.IPBan.findOne({ ...options, where: { address: canonicalIP(address) } });
    if (row && (!row.expiresAt || new Date(row.expiresAt).getTime() > now)) { throw 0xA; }
}
async function privilege(models, id, realmUid, options = {}) {
    // Presence of an override (including zero) wins over the global row.
    if (realmUid) {
        const override = await models.GameAccountPrivilege.findOne({ ...options, where: { gameAccountId: id, realmUid } });
        if (override) { return override.level; }
    }
    const global = await models.GameAccountPrivilege.findOne({ ...options, where: { gameAccountId: id, realmUid: '' } });
    return global?.level ?? 0;
}
module.exports = { privilege, canonicalIP, trustedPeer, banned, blocked, checkIP };
