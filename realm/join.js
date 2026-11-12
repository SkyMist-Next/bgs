'use strict';

const crypto = require('node:crypto');
const { privilege } = require('../utils/admin-state');
const { ClientSessions, eligibleGame } = require('../utils/client-sessions');
const { Sessions, JOIN_TICKET_SECONDS } = require('./sessions');
const { CataclysmSessions } = require('./cataclysm-sessions');
const { realmAccountName } = require('../utils/wow-license');

// Realm-list tickets share the client session lifetime.
const LIST_TICKET_SECONDS = 300;
const LIST_TICKET_PREFIX = '/aurora/services/GameUtilitiesService/realmListTickets/';
const VERSION_FIELDS = ['versionMajor', 'versionMinor', 'versionRevision', 'versionBuild'];

function clientPlatform(value = 'Win') {
    if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) { throw 0xA; }
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32BE(value);
        value = bytes.toString('latin1').replace(/\0+$/, '');
    }
    if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,4}$/.test(value)) { throw 0xA; }
    return value;
}
function realmAddress(region, battlegroup, realmId) {
    return (((region & 0xFF) << 24) | ((battlegroup & 0xFF) << 16) | (realmId & 0xFFFF)) >>> 0;
}
function endpoints(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch { return null; }
}
// The typed view of one operator realmlist row.
function realm(row) {
    return {
        address: realmAddress(row.region, row.battlegroup, row.realm_id), subRegion: row.region + '-' + row.battlegroup + '-0',
        realmUid: row.realm_uid, namespace: row.namespace, available: Boolean(row.available), securityLevel: row.security_level,
        region: row.region, expansion: row.expansion, build: row.build, endpoints: endpoints(row.endpoints),
        update: { name: row.name, cfgTimezonesID: 1, cfgCategoriesID: row.timezone, cfgRealmsID: row.realm_id,
            cfgConfigsID: row.game_type + 1, cfgLanguagesID: 1, populationState: row.available ? Math.max(row.population, 1) : 0,
            version: { versionMajor: row.version_major, versionMinor: row.version_minor, versionRevision: row.version_revision, versionBuild: row.build } }
    };
}
const sameVersion = (left, right) => VERSION_FIELDS.every(key => left[key] === right[key]);

// Each client build joins through its own realm authentication contract.
const BUILDS = {
    26972: {
        async issue(join, record, ticket) {
            const joinSecret = crypto.randomBytes(32);
            record.client_secret = Buffer.from(ticket.info.secret).toString('hex');
            record.join_secret = joinSecret.toString('hex');
            const joinTicket = crypto.randomBytes(20);
            await join.sessions.issue(joinTicket.toString('hex'), record);
            return { ticket: joinTicket, joinSecret };
        }
    },
    15595: {
        async issue(join, record, ticket, game) {
            const accountName = realmAccountName(game.accountId, game.wowLicenseIndex), sessionKey = crypto.randomBytes(40);
            Object.assign(record, { auth_protocol: 'wow-15595-v0', wow_license_index: game.wowLicenseIndex,
                realm_account_name: accountName, realm_key: sessionKey.toString('hex') });
            record.issued_at_ms = Date.now();
            record.expires_at_ms = record.issued_at_ms + JOIN_TICKET_SECONDS * 1000;
            for (let retry = 0; retry < 8; retry++) {
                const joinTicket = crypto.randomBytes(20);
                try {
                    await join.cataclysmSessions.issue(joinTicket.toString('hex'), record);
                    return { ticket: joinTicket, accountName, sessionKey };
                } catch (error) { if (error.code !== 'TICKET_COLLISION') { throw error; } }
            }
            throw 0x80000075;
        }
    }
};

class RealmJoin {
    constructor({ store, models, realmDirectory }) {
        Object.assign(this, { store, models, realmDirectory });
        this.clientSessions = new ClientSessions(store, models);
        this.sessions = new Sessions(store);
        this.cataclysmSessions = new CataclysmSessions(store);
    }

    async issueListTicket(context, { gameAccountId, clientInfo }) {
        const owner = await this.clientSessions.resolve(context);
        const game = await this.clientSessions.ownedGame(owner, gameAccountId);
        if (game.program !== 'WoW') { throw 0xA; }
        const info = clientInfo?.info;
        if (!Number.isInteger(info?.version?.versionBuild) || info.version.versionBuild <= 0 || (owner.applicationVersion && owner.applicationVersion !== info.version.versionBuild)) { throw 0xA; }
        if (!Array.isArray(info.secret) || info.secret.length !== 32 || info.secret.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) { throw 0xA; }
        info.platform = clientPlatform(info.platform);
        const ticket = crypto.randomBytes(20);
        const record = { info, identity: { gameAccountId: String(game.id), gameAccountRegion: game.region }, owner };
        try { await this.store.run(client => client.set(LIST_TICKET_PREFIX + ticket.toString('hex'), JSON.stringify(record), { EX: LIST_TICKET_SECONDS })); }
        catch { throw 0x80000076; } //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_REALM_LIST_TICKET
        return ticket;
    }

    async listRealms(context, ticket, subRegion) {
        let realms;
        try { realms = (await this.catalog()).filter(entry => entry.subRegion === subRegion); }
        catch { throw 0x8000006D; } //ERROR_UTIL_SERVER_MISSING_REALM_LIST
        const { record, game } = await this.listTicket(ticket, context);
        try {
            const counts = await this.models.GameAccountCharacters.findAll({ where: { game_account_id: String(game.id) },
                attributes: ['realm_uid', 'character_count'], limit: 4097, raw: true });
            if (counts.length > 4096) { throw 0xA; }
            const countByRealm = new Map(counts.map(row => [row.realm_uid, row.character_count]));
            const visible = realms.filter(entry => Number.isInteger(entry.expansion) && entry.expansion === game.expansion &&
                sameVersion(entry.update.version, record.info.version) && Number(subRegion.split('-')[0]) === record.identity.gameAccountRegion);
            return {
                updates: visible.map(entry => ({ update: { ...entry.update, wowRealmAddress: entry.address, flags: entry.available ? 0 : 0x2 }, deleting: false })),
                counts: visible.map(entry => ({ count: countByRealm.get(entry.realmUid) || 0, wowRealmAddress: entry.address }))
            };
        } catch { throw 0x80000075; } //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_JOIN_TICKET
    }

    async join(context, ticket, address, build) {
        const projection = BUILDS[build];
        // A client joins only through its own build's contract.
        if (!projection || (await this.clientSessions.resolve(context)).applicationVersion !== build) { throw 0xA; }
        let selected;
        try { selected = (await this.catalog()).find(entry => entry.address === address); }
        catch { throw 0x8000006B; }
        if (!selected) { throw 0x8000006B; } //ERROR_UTIL_SERVER_MISSING_VIRTUAL_REALM
        if (!selected.endpoints) { throw 0x8000012F; } //ERROR_WOW_SERVICES_INVALID_SERVER_ADDRESSES
        const { record, game } = await this.listTicket(ticket, context);
        try {
            const security = await privilege(this.models, String(game.id), selected.realmUid);
            if (!Number.isInteger(selected.expansion) || selected.expansion !== game.expansion || !selected.available || selected.region !== game.region ||
                selected.build !== build || record.owner.applicationVersion !== build || !sameVersion(selected.update.version, record.info.version) ||
                security < selected.securityLevel) { throw 0xA; }
            const joinRecord = {
                version: 1, namespace: selected.namespace, realm_uid: selected.realmUid,
                game_account_id: String(game.id), account_id: String(game.accountId),
                credential_version: String(record.owner.credentialVersion ?? 1),
                authenticator_generation: String(record.owner.authenticatorGeneration ?? 0),
                authenticator_verified_at: Number(record.owner.authenticatorVerifiedAt ?? 0),
                expansion: game.expansion, build: selected.build, region: game.region, address: record.owner.address,
                locale: record.info.locale || 'enUS', platform: clientPlatform(record.info.platform), gm_level: security
            };
            return { endpoints: selected.endpoints, ...await projection.issue(this, joinRecord, record, game) };
        } catch { throw 0x80000075; } //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_JOIN_TICKET
    }

    // Sub-regions offering realms for the caller's build and eligible licenses.
    async subRegions(context) {
        const owner = await this.clientSessions.resolve(context);
        const accounts = await this.models.GameAccount.findAll({ where: { accountId: owner.accountId, program: 'WoW' } });
        const regions = new Set(accounts.filter(account => eligibleGame(account, owner.applicationVersion)).map(account => account.region));
        const result = [];
        for (const entry of await this.catalog()) {
            if (regions.has(entry.region) && entry.build === owner.applicationVersion && !result.includes(entry.subRegion)) { result.push(entry.subRegion); }
        }
        return result;
    }

    async catalog() { return (await this.realmDirectory.rows()).map(realm); }

    // A realm-list ticket is usable only by the session and license it was issued to.
    async listTicket(ticket, context) {
        try {
            const raw = await this.store.run(client => client.get(LIST_TICKET_PREFIX + ticket.toString('hex')));
            const record = JSON.parse(raw);
            const owner = await this.clientSessions.resolve(context);
            if (!record?.owner || record.owner.connectionId !== owner.connectionId || record.owner.accountId !== owner.accountId || record.owner.address !== owner.address) { throw 0xA; }
            if (String(record.owner.credentialVersion ?? 1) !== String(owner.credentialVersion ?? 1) ||
                String(record.owner.authenticatorGeneration ?? 0) !== String(owner.authenticatorGeneration ?? 0)) { throw 0xA; }
            const game = await this.clientSessions.ownedGame(owner, record.identity.gameAccountId);
            if (game.region !== record.identity.gameAccountRegion || (owner.applicationVersion && owner.applicationVersion !== record.info.version.versionBuild)) { throw 0xA; }
            return { record, game };
        } catch { throw 0x8000012D; } //ERROR_WOW_SERVICES_INVALID_REALM_LIST_TICKET
    }
}
module.exports = { RealmJoin, LIST_TICKET_SECONDS };
