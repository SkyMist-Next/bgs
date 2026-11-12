'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const loadProto = require('../utils/protobuf');

const Service = require('./service.js');
const { principal, gameAccount, privilege, blocked } = require('../utils/admin-state');
const { Sessions, JOIN_TICKET_SECONDS } = require('../realm/sessions');
const { CataclysmSessions } = require('../realm/cataclysm-sessions');
const { realmAccountName } = require('../utils/wow-license');
// Realm-list tickets share the login ticket and connection identity lifetime.
const LIST_TICKET_SECONDS = 300;

const gameUtilitiesTypes = loadProto('proto/bgs/low/pb/client/game_utilities_types.proto');

const Attribute = gameUtilitiesTypes.lookupType('bgs.protocol.Attribute');
const Variant = gameUtilitiesTypes.lookupType('bgs.protocol.Variant');

function GetJSON(variant, name) {
    if (!Buffer.isBuffer(variant?.blobValue) || variant.blobValue.length > 4 * 1024 * 1024) { throw 0xA; }
    try {
        const string = new TextDecoder('utf-8', { fatal: true }).decode(variant.blobValue);
        if (!string.startsWith(name + ':') || !string.endsWith('\0') || string.slice(0, -1).includes('\0')) { throw 0xA; }
        return JSON.parse(string.slice(name.length + 1, -1));
    } catch { throw 0xA; }
}

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

function deflateJSONAttributeValue(name, object) {
    let string = name + ":" + JSON.stringify(object);
    let stringBuffer = Buffer.from(string);
    let CStringBuffer = Buffer.alloc(stringBuffer.length + 1);
    stringBuffer.copy(CStringBuffer);
    CStringBuffer.writeUInt8(0, stringBuffer.length);
    let compressed = zlib.deflateSync(CStringBuffer);
    let buffer = Buffer.alloc(4 + compressed.length);
    buffer.writeInt32LE(CStringBuffer.length, 0);
    compressed.copy(buffer, 4);
    return buffer;
}

function realmAddressToString(address) {
    const realmId = address & 0xFFFF;
    const battleGroupId = (address >> 16) & 0xFF;
    const region = (address >> 24) & 0xFF;
    return region.toString() + '-' + battleGroupId.toString() + '-' + realmId.toString();
}

function stringToRealmAddress(string) {
    let parts = string.split('-');
    return (((Number.parseInt(parts[0], 10) & 0xFF) << 24) |
            ((Number.parseInt(parts[1], 10) & 0xFF) << 16) |
            (Number.parseInt(parts[2], 10) & 0xFFFF)) >>> 0;
}

class GameUtilitiesService extends Service {
    constructor({ logger, store, models, realmDirectory }) {
        super('GameUtilitiesService', 'proto/bgs/low/pb/client/game_utilities_service.proto', { logger });
        this.store = store;
        this.sessions = new Sessions(store);
        this.cataclysmSessions = new CataclysmSessions(store);
        this.models = models;
        this.realms = realmDirectory || new (require('../utils/realm-directory'))(models, models.realmDatabase);

        this.commandHandlers = {};

        this.registerHandler('ProcessClientRequest', this.ProcessClientRequest.bind(this));

        this.registerHandler('GetAllValuesForAttribute', this.GetAllValuesForAttribute.bind(this));

        this.registerCommand('RealmListTicketRequest', async (params, commandValue, context) => {
            const owner = await principal(this.models, this.store, context);
            let identity = GetJSON(params.Identity, 'JSONRealmListTicketIdentity');
            const game = await gameAccount(this.models, owner, identity.gameAccountID);
            identity = { gameAccountId: String(game.id), gameAccountRegion: game.region };
            if (game.program !== 'WoW' || (owner.applicationVersion === 15595 && game.expansion !== 3)) { throw 0xA; }
            let clientInfo = GetJSON(params.ClientInfo, 'JSONRealmListTicketClientInformation');
            if (!Number.isInteger(clientInfo.info?.version?.versionBuild) || clientInfo.info.version.versionBuild <= 0 || (owner.applicationVersion && owner.applicationVersion !== clientInfo.info.version.versionBuild)) { throw 0xA; }
            if (!Array.isArray(clientInfo.info.secret) || clientInfo.info.secret.length !== 32 || clientInfo.info.secret.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) { throw 0xA; }

            clientInfo.info.platform = clientPlatform(clientInfo.info.platform);

            let listTicket = crypto.randomBytes(20);
            let listTicketKey = this.listTicketPath(listTicket.toString('hex'));

            let listTicketInfo = {
                info: clientInfo.info,
                identity: identity,
                owner
            };

            this.logger.debug('Created RealmListRequest');

            return this.store.setJSON(listTicketKey, listTicketInfo, LIST_TICKET_SECONDS).then(() => {
                let responseParams = {
                    RealmListTicket: null
                };

                responseParams.RealmListTicket = Variant.create();
                responseParams.RealmListTicket.blobValue = listTicket;

                return Promise.resolve(responseParams);
            }, () => {
                return Promise.reject(0x80000076) //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_REALM_LIST_TICKET
            });
        });

        this.registerCommand('RealmListRequest', async (params, commandValue, context) => {
            const listTicketPath = this.listTicketPath(params.RealmListTicket.blobValue.toString('hex'));
            const subRegion = commandValue.stringValue;
            const realmsPrefix = '/aurora/services/WoWService/subRegions/' + subRegion + '/virtualRealms/';

            this.logger.debug('Received RealmListRequest');

            let realms;
            try { realms = await this.realms.listMetadataJSON(realmsPrefix); }
            catch { throw 0x8000006D; } //ERROR_UTIL_SERVER_MISSING_REALM_LIST
            let realmListUpdates = Object.getOwnPropertyNames(realms).map((virtualRealmAddressKey) => {
                const realm = realms[virtualRealmAddressKey];
                const realmEntry = { update: { ...realm.update }, realmUID: realm.realmUID, expansion: realm.expansion, deleting: realm.deleting };
                realmEntry.update.wowRealmAddress = stringToRealmAddress(virtualRealmAddressKey.split('/').pop());
                //TODO calculate the population state by counting all characters, possibly use DB for realm
                realmEntry.update.populationState = realm.update.populationState;
                realmEntry.update.flags = 0;
                if (realm.isHidden) { realmEntry.update.flags |= 0x2; }
                if (realm.isTournament) { realmEntry.update.flags |= 0x4; }
                return realmEntry;
            });

            const { listTicketInfo, game } = await this.loadListTicket(listTicketPath, context);
            try {
                const counts = await this.models.GameAccountCharacters.findAll({ where: { game_account_id: String(game.id) },
                    attributes: ['realm_uid', 'character_count'], limit: 4097, raw: true });
                if (counts.length > 4096) { throw 0xA; }
                const countByRealm = new Map(counts.map(row => [row.realm_uid, row.character_count]));
                realmListUpdates = realmListUpdates.filter(entry => Number.isInteger(entry.expansion) && entry.expansion === game.expansion && ['versionMajor', 'versionMinor', 'versionRevision', 'versionBuild'].every(key => entry.update.version[key] === listTicketInfo.info.version[key]) &&
                    Number(subRegion.split('-')[0]) === listTicketInfo.identity.gameAccountRegion);
                const characterCounts = realmListUpdates.map((realmEntry) => {
                    if (realmEntry.update.version.versionMajor !== listTicketInfo.info.version.versionMajor ||
                        realmEntry.update.version.versionMinor !== listTicketInfo.info.version.versionMinor ||
                        realmEntry.update.version.versionRevision !== listTicketInfo.info.version.versionRevision) { realmEntry.update.flags |= 0x1; }
                    const count = { count: countByRealm.get(realmEntry.realmUID) || 0, wowRealmAddress: realmEntry.update.wowRealmAddress };
                    delete realmEntry.realmUID;
                    delete realmEntry.expansion;
                    return count;
                });
                const responseParams = { RealmList: Variant.create(), CharacterCountList: Variant.create() };
                responseParams.RealmList.blobValue = deflateJSONAttributeValue('JSONRealmListUpdates', { updates: realmListUpdates });
                responseParams.CharacterCountList.blobValue = deflateJSONAttributeValue('JSONRealmCharacterCountList', { counts: characterCounts });
                return responseParams;
            } catch { throw 0x80000075; } //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_JOIN_TICKET
        });

        this.registerCommand('RealmJoinRequest', async (params, commandValue, context, command = { version: 'v1' }) => {
            const cataclysm = command.version === 'v0';
            const subRegion = commandValue.stringValue;
            const listTicketPath = this.listTicketPath(params.RealmListTicket.blobValue.toString('hex'));
            const realmAddress = realmAddressToString(params.RealmAddress.uintValue.getLowBitsUnsigned());
            const realmPath = '/aurora/services/WoWService/subRegions/' + subRegion + '/virtualRealms/' + realmAddress;

            this.logger.debug('Received RealmJoinRequest for realm: ' + realmAddress);

            const responseParams = {
                ServerAddresses: Variant.create(),
                RealmJoinTicket: Variant.create(),
                ...(cataclysm ? { RealmAccountName: Variant.create(), RealmSessionKey: Variant.create() } : { JoinSecret: Variant.create() })
            };

            let virtualRealm;
            try { virtualRealm = await this.realms.getMetadataJSON(realmPath); }
            catch { throw 0x8000006B; } //ERROR_UTIL_SERVER_MISSING_VIRTUAL_REALM
            const realmUid = virtualRealm.realmUID;
            try { await this.realms.getMetadataJSON('/aurora/services/WoWService/subRegions/' + subRegion + '/gameServers/' + virtualRealm.gameServerId); }
            catch { throw 0x8000012F; } //ERROR_WOW_SERVICES_INVALID_SERVER_ADDRESSES
            const { listTicketInfo, game } = await this.loadListTicket(listTicketPath, context);

            try {
                const selectedRealm = await this.realms.getMetadataJSON(realmPath);
                responseParams.ServerAddresses.blobValue = deflateJSONAttributeValue('JSONRealmListServerIPAddresses', { families: selectedRealm.endpoints });
                const security = await privilege(this.models, String(game.id), realmUid);
                if (!Number.isInteger(selectedRealm.expansion) || selectedRealm.expansion !== game.expansion || !selectedRealm.available || selectedRealm.region !== game.region || selectedRealm.build !== listTicketInfo.info.version.versionBuild || !(['versionMajor', 'versionMinor', 'versionRevision', 'versionBuild'].every(key => selectedRealm.update.version[key] === listTicketInfo.info.version[key])) ||
                    security < selectedRealm.securityLevel) { throw 0xA; }
                const build = cataclysm ? 15595 : 26972;
                if (listTicketInfo.owner.applicationVersion !== build || selectedRealm.build !== build ||
                    game.expansion !== (cataclysm ? 3 : 6)) { throw 0xA; }
                responseParams.RealmJoinTicket.blobValue = crypto.randomBytes(20);
                if (cataclysm) {
                    responseParams.RealmAccountName.stringValue = realmAccountName(game.accountId, game.wowLicenseIndex);
                    responseParams.RealmSessionKey.blobValue = crypto.randomBytes(40);
                } else { responseParams.JoinSecret.blobValue = crypto.randomBytes(32); }

                const joinTicketInfo = {
                    version: 1,
                    namespace: selectedRealm.namespace,
                    realm_uid: realmUid,
                    game_account_id: String(game.id),
                    account_id: String(game.accountId),
                    credential_version: String(listTicketInfo.owner.credentialVersion ?? 1),
                    authenticator_generation: String(listTicketInfo.owner.authenticatorGeneration ?? 0),
                    authenticator_verified_at: Number(listTicketInfo.owner.authenticatorVerifiedAt ?? 0),
                    expansion: game.expansion,
                    build: selectedRealm.build,
                    region: game.region,
                    address: listTicketInfo.owner.address,
                    locale: listTicketInfo.info.locale || 'enUS',
                    platform: clientPlatform(listTicketInfo.info.platform),
                    gm_level: security,
                    ...(cataclysm ? {
                        auth_protocol: 'wow-15595-v0', wow_license_index: game.wowLicenseIndex,
                        realm_account_name: responseParams.RealmAccountName.stringValue,
                        realm_key: responseParams.RealmSessionKey.blobValue.toString('hex')
                    } : { client_secret: Buffer.from(listTicketInfo.info.secret).toString('hex'),
                        join_secret: responseParams.JoinSecret.blobValue.toString('hex') }),
                };
                if (!cataclysm) {
                    await this.sessions.issue(responseParams.RealmJoinTicket.blobValue.toString('hex'), joinTicketInfo);
                    return responseParams;
                }
                joinTicketInfo.issued_at_ms = Date.now();
                joinTicketInfo.expires_at_ms = joinTicketInfo.issued_at_ms + JOIN_TICKET_SECONDS * 1000;
                for (let retry = 0; retry < 8; retry++) {
                    try {
                        await this.cataclysmSessions.issue(responseParams.RealmJoinTicket.blobValue.toString('hex'), joinTicketInfo);
                        return responseParams;
                    } catch (error) {
                        if (error.code !== 'TICKET_COLLISION') { throw error; }
                        responseParams.RealmJoinTicket.blobValue = crypto.randomBytes(20);
                    }
                }
                throw 0x80000075;
            } catch { throw 0x80000075; } //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_JOIN_TICKET
        });
    }

    listTicketPath(listTicket) {
        return '/aurora/services/' + this.getServiceName() + '/realmListTickets/' + listTicket;
    }

    async loadListTicket(path, context) {
        try {
            const listTicketInfo = await this.store.getJSON(path);
            await this.validateTicket(listTicketInfo, context);
            return { listTicketInfo, game: await gameAccount(this.models, listTicketInfo.owner, listTicketInfo.identity.gameAccountId) };
        } catch { throw 0x8000012D; } //ERROR_WOW_SERVICES_INVALID_REALM_LIST_TICKET
    }

    async validateTicket(ticket, context) {
        const owner = await principal(this.models, this.store, context);
        if (!ticket?.owner || ticket.owner.connectionId !== owner.connectionId || ticket.owner.accountId !== owner.accountId || ticket.owner.address !== owner.address) { throw 0xA; }
        if (String(ticket.owner.credentialVersion ?? 1) !== String(owner.credentialVersion ?? 1) ||
            String(ticket.owner.authenticatorGeneration ?? 0) !== String(owner.authenticatorGeneration ?? 0)) { throw 0xA; }
        const game = await gameAccount(this.models, owner, ticket.identity.gameAccountId);
        if (game.region !== ticket.identity.gameAccountRegion || (owner.applicationVersion && owner.applicationVersion !== ticket.info.version.versionBuild)) { throw 0xA; }
    }

    registerCommand(command, handler) {
        this.commandHandlers[command] = handler;
    }

    handleCommand(command, params, context) {
        if (Object.hasOwn(this.commandHandlers, command.name)) {
            return this.commandHandlers[command.name](params, command.value, context, command).then((responseParams) => {
                let attributes = [];
                Object.getOwnPropertyNames(responseParams).forEach((responseParamName) => {
                    let attribute = Attribute.create();
                    attribute.name = 'Param_' + responseParamName;
                    attribute.value = responseParams[responseParamName];
                    attributes.push(attribute);
                });

                return Promise.resolve(attributes);
            }, (error) => {
                this.logger.error('Error: '+ error + ' in command: ' + command.name);
                return Promise.reject(error);
            });
        }
        else {
            //reject with unknown command ?
            this.logger.error('Unknown command: ' + command.name + ' received from client');
            return Promise.reject(0x000084D3);
        }
    }

    async ProcessClientRequest(context) {
        const attributes = context.request.attribute;
        if (!Array.isArray(attributes) || attributes.length > 8) { throw 0xA; }
        let command;
        const params = Object.create(null);
        for (const attribute of attributes) {
            if (typeof attribute.name !== 'string' || !attribute.value) { throw 0xA; }
            if (attribute.name.startsWith('Command_')) {
                if (command) { throw 0xA; }
                const match = /^Command_([A-Za-z]+)_(v[0-9]+)_(b[0-9]+)$/.exec(attribute.name);
                if (!match) { throw 0x000084D3; }
                command = { name: match[1], version: match[2], auroraVersion: match[3], value: attribute.value };
            } else {
                const match = /^Param_([A-Za-z]+)$/.exec(attribute.name);
                if (!match || Object.hasOwn(params, match[1])) { throw 0xA; }
                params[match[1]] = attribute.value;
            }
        }
        if (!command) { throw 0xA; }
        if (!Object.hasOwn(this.commandHandlers, command.name) || command.auroraVersion !== 'b9' ||
            !(command.version === 'v1' || (command.name === 'RealmJoinRequest' && command.version === 'v0'))) { throw 0x000084D3; }
        const shape = command.name === 'RealmListTicketRequest' ? { Identity: 'blobValue', ClientInfo: 'blobValue' } :
            command.name === 'RealmListRequest' ? { RealmListTicket: 'blobValue' } : { RealmListTicket: 'blobValue', RealmAddress: 'uintValue' };
        if (Object.keys(params).sort().join(',') !== Object.keys(shape).sort().join(',')) { throw 0xA; }
        const variant = (value, type) => {
            const fields = Object.keys(value).filter(key => Object.hasOwn(Variant.fields, key));
            if (fields.length !== (type ? 1 : 0) || (type && fields[0] !== type)) { throw 0xA; }
            if (type === 'blobValue' && !Buffer.isBuffer(value[type])) { throw 0xA; }
            if (type === 'stringValue' && typeof value[type] !== 'string') { throw 0xA; }
        };
        variant(command.value, command.name === 'RealmListTicketRequest' ? null : 'stringValue');
        for (const [name, type] of Object.entries(shape)) { variant(params[name], type); }
        if (params.RealmListTicket && params.RealmListTicket.blobValue.length !== 20) { throw 0xA; }
        if (command.name !== 'RealmListTicketRequest' && !/^[1-9][0-9]{0,2}-[0-9]{1,3}-0$/.test(command.value.stringValue)) { throw 0xA; }
        if (command.name === 'RealmJoinRequest') {
            let address;
            try { address = BigInt(params.RealmAddress.uintValue.toString()); } catch { throw 0xA; }
            if (address < 1n || address > 0xFFFFFFFFn || (address & 0xFFFFn) === 0n ||
                command.value.stringValue !== Number((address >> 24n) & 255n) + '-' + Number((address >> 16n) & 255n) + '-0') { throw 0xA; }
            const owner = await principal(this.models, this.store, context);
            if (owner.applicationVersion !== (command.version === 'v0' ? 15595 : 26972)) { throw 0xA; }
        }
        context.response.attribute = await this.handleCommand(command, params, context);
        return 0;
    }

    async GetAllValuesForAttribute(context) {
        switch (context.request.attributeKey) {
            case 'Command_RealmListRequest_v1_b9': {
                const owner = await principal(this.models, this.store, context);
                const accounts = await this.models.GameAccount.findAll({ where: { accountId: owner.accountId, program: 'WoW' } });
                const regions = new Set(accounts.filter(a => !blocked(a) && (owner.applicationVersion !== 15595 || a.expansion === 3)).map(a => a.region));
                let subRegionPrefix = '/aurora/services/WoWService/subRegions/';
                return this.realms.listMetadata(subRegionPrefix).then((subRegions) => {
                    Object.keys(subRegions).forEach((subRegionKey) => {
                        const realm = subRegions[subRegionKey];
                        if (!regions.has(realm.region) || realm.build !== owner.applicationVersion) { return; }
                        let subRegionId = subRegionKey.split('/')[5];

                        let subRegionIndex = context.response.attributeValue.findIndex((variant) => {
                            return variant.stringValue === subRegionId;
                        });

                        if (subRegionIndex === -1) {
                            let variant = Variant.create();
                            variant.stringValue = subRegionId;
                            context.response.attributeValue.push(variant);
                        }
                    });
                    return Promise.resolve(0);
                });
            }
            default: {
                return Promise.resolve(0x00000BC7);
            }
        }
    }
}

module.exports = GameUtilitiesService;
