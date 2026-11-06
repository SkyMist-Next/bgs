'use strict';

const MAX_INDEX = 0xFFFFFFFF;
function accountID(value) {
    const text = String(value);
    if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) {
        throw new Error('Invalid account identity');
    }
    return text;
}
function licenseIndex(value) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_INDEX) { throw new Error('Invalid WoW license index'); }
    return value;
}
function realmAccountName(account, index) { return accountID(account) + '#' + licenseIndex(index); }
function parseRealmAccountName(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}#[1-9][0-9]{0,9}$/.test(value)) { throw new Error('Invalid realm account name'); }
    const [account, index] = value.split('#');
    return { accountId: accountID(account), wowLicenseIndex: licenseIndex(Number(index)) };
}
async function allocate(models, accountId, transaction) {
    if (!transaction) { throw new Error('WoW license allocation requires a transaction'); }
    const parent = await models.Account.findByPk(accountID(accountId), { transaction, lock: transaction.LOCK.UPDATE });
    if (!parent) { throw new Error('Missing parent account'); }
    const high = parent.wowLicenseIndexHighWater;
    if (!Number.isInteger(high) || high < 0 || high >= MAX_INDEX) { throw new Error('WoW license index exhausted or invalid'); }
    const next = high + 1;
    await parent.update({ wowLicenseIndexHighWater: next }, { transaction });
    return next;
}
module.exports = { MAX_INDEX, accountID, licenseIndex, realmAccountName, parseRealmAccountName, allocate };
