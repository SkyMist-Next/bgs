'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const loadProto = require('../utils/protobuf');

const Service = require('./service.js');
const { principal, gameAccount, privilege, blocked } = require('../utils/admin-state');

const gameUtilitiesTypes = loadProto('proto/bgs/low/pb/client/game_utilities_types.proto');

const Attribute = gameUtilitiesTypes.lookupType('bgs.protocol.Attribute');
const Variant = gameUtilitiesTypes.lookupType('bgs.protocol.Variant');

function GetJSON(variant, name) {
    let string = variant.blobValue.toString();
    return JSON.parse(string.slice(name.length + 1, string.length - 1));
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

function bufferToArray(buffer) {
    let array = [];
    for (const value of buffer) {
        array.push(value);
    }

    return array;
}

class GameUtilitiesService extends Service {
    constructor({ logger, store, models, realmDirectory }) {
        super('GameUtilitiesService', 'proto/bgs/low/pb/client/game_utilities_service.proto', { logger });
        this.store = store;
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
            if (game.program !== 'WoW') { throw 0xA; }
            let clientInfo = GetJSON(params.ClientInfo, 'JSONRealmListTicketClientInformation');
            if (!Number.isInteger(clientInfo.info?.version?.versionBuild) || clientInfo.info.version.versionBuild <= 0 || (owner.applicationVersion && owner.applicationVersion !== clientInfo.info.version.versionBuild)) { throw 0xA; }

            let listTicket = crypto.randomBytes(20);
            let listTicketKey = '/aurora/services/' + this.getServiceName() + '/realmListTickets/' + listTicket.toString('hex');

            let listTicketInfo = {
                info: clientInfo.info,
                identity: identity,
                owner
            };

            this.logger.debug('Created RealmListRequest');

            return this.store.setJSON(listTicketKey, listTicketInfo).then(() => {
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

        this.registerCommand('RealmListRequest', (params, commandValue, context) => {
            let listTicket = params.RealmListTicket.blobValue.toString('hex');
            let listTicketPath = '/aurora/services/' + this.getServiceName() + '/realmListTickets/' + listTicket;
            let subRegion = commandValue.stringValue;
            let realmsPrefix = '/aurora/services/WoWService/subRegions/' + subRegion + '/virtualRealms/';
            let realmListUpdates = [];
            let characterCounts = [];

            let responseParams = {
                RealmList: Variant.create(),
                CharacterCountList: Variant.create()
            };

            this.logger.debug('Received RealmListRequest');

            return this.realms.listMetadataJSON(realmsPrefix).
            then((realms) => {
                Object.getOwnPropertyNames(realms).forEach((virtualRealmAddressKey) => {
                    let realmEntry = {
                        update: {},
                        deleting: null
                    };

                    let virtualRealmAddress = virtualRealmAddressKey.split('/').pop();

                    Object.assign(realmEntry.update, realms[virtualRealmAddressKey].update);
                    realmEntry.update.wowRealmAddress = stringToRealmAddress(virtualRealmAddress);
                    //TODO calculate the population state by counting all characters, possibly use DB for realm
                    realmEntry.update.populationState = realms[virtualRealmAddressKey].update.populationState;
                    realmEntry.update.flags = 0;

                    if (realms[virtualRealmAddressKey].isHidden)
                        realmEntry.update.flags |= 0x2;

                    if (realms[virtualRealmAddressKey].isTournament)
                        realmEntry.update.flags |= 0x4;

                    realmEntry.deleting = realms[virtualRealmAddressKey].deleting;

                    realmListUpdates.push(realmEntry);
                });

                return this.store.getJSON(listTicketPath);
            }, () => {
                return Promise.reject(0x8000006D) //ERROR_UTIL_SERVER_MISSING_REALM_LIST
            }).
            then(async (listTicketInfo) => {
                await this.validateTicket(listTicketInfo, context);
                realmListUpdates = realmListUpdates.filter(entry => ['versionMajor', 'versionMinor', 'versionRevision', 'versionBuild'].every(key => entry.update.version[key] === listTicketInfo.info.version[key]) &&
                    Number(subRegion.split('-')[0]) === listTicketInfo.identity.gameAccountRegion);
                realmListUpdates.forEach((realmEntry) => {
                    if (realmEntry.update.version.versionMajor !== listTicketInfo.info.version.versionMajor ||
                        realmEntry.update.version.versionMinor !== listTicketInfo.info.version.versionMinor ||
                        realmEntry.update.version.versionRevision !== listTicketInfo.info.version.versionRevision)
                        realmEntry.update.flags |= 0x1;

                    //TODO for each realm check if any characters exist for this GameAccount, for now put static count of 0
                    characterCounts.push({ count: 0, wowRealmAddress: realmEntry.update.wowRealmAddress });
                });

                responseParams.RealmList.blobValue = deflateJSONAttributeValue('JSONRealmListUpdates', {updates: realmListUpdates});
                responseParams.CharacterCountList.blobValue = deflateJSONAttributeValue('JSONRealmCharacterCountList', {counts: characterCounts});
                return Promise.resolve(responseParams);
            }, () => {
                return Promise.reject(0x80000075) //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_JOIN_TICKET
            })
        });

        this.registerCommand('RealmJoinRequest', (params, commandValue, context) => {
            let subRegion = commandValue.stringValue;
            let realmUid;
            let selectedRealm;
            let listTicket = params.RealmListTicket.blobValue.toString('hex');
            let realmAddress = realmAddressToString(params.RealmAddress.uintValue.getLowBitsUnsigned());

            this.logger.debug('Received RealmJoinRequest for realm: ' + realmAddress);

            let responseParams = {
                ServerAddresses: Variant.create(),
                RealmJoinTicket: Variant.create(),
                JoinSecret: Variant.create()
            };

            return this.realms.getMetadataJSON('/aurora/services/WoWService/subRegions/' + subRegion + '/virtualRealms/' + realmAddress).
            then((virtualRealm) => {
                realmUid = virtualRealm.realmUID;
                selectedRealm = virtualRealm;
                return this.realms.getMetadataJSON('/aurora/services/WoWService/subRegions/' + subRegion + '/gameServers/' + virtualRealm.gameServerId)
            }, () => {
                return Promise.reject(0x8000006B) //ERROR_UTIL_SERVER_MISSING_VIRTUAL_REALM
            }).
            then((gameServer) => {
                responseParams.ServerAddresses.blobValue = deflateJSONAttributeValue('JSONRealmListServerIPAddresses', { families: gameServer.endpoints});
                return this.store.getJSON('/aurora/services/' + this.getServiceName() + '/realmListTickets/' + listTicket);
            }, () => {
                return Promise.reject(0x8000012F) //ERROR_WOW_SERVICES_INVALID_SERVER_ADDRESSES
            }).
            then(async (listTicketInfo) => {
                await this.validateTicket(listTicketInfo, context);
                const game = await gameAccount(this.models, listTicketInfo.owner, listTicketInfo.identity.gameAccountId);
                selectedRealm = await this.realms.getMetadataJSON('/aurora/services/WoWService/subRegions/' + subRegion + '/virtualRealms/' + realmAddress);
                responseParams.ServerAddresses.blobValue = deflateJSONAttributeValue('JSONRealmListServerIPAddresses', { families: selectedRealm.endpoints });
                if (!selectedRealm.available || selectedRealm.region !== game.region || selectedRealm.build !== listTicketInfo.info.version.versionBuild || !(['versionMajor', 'versionMinor', 'versionRevision', 'versionBuild'].every(key => selectedRealm.update.version[key] === listTicketInfo.info.version[key])) ||
                    await privilege(this.models, game.id, realmUid) < selectedRealm.securityLevel) { throw 0xA; }
                responseParams.RealmJoinTicket.blobValue = crypto.randomBytes(20);
                responseParams.JoinSecret.blobValue = crypto.randomBytes(32);

                let joinTicketInfo = {
                    owner: listTicketInfo.owner,
                    realmUID: realmUid || null,
                    gmLevel: await privilege(this.models, listTicketInfo.identity.gameAccountId, realmUid),
                    subRegion: subRegion,
                    realmAddress: realmAddress,
                    gameAccount: listTicketInfo.identity,
                    clientSecret: listTicketInfo.info.secret,
                    joinSecret: bufferToArray(responseParams.JoinSecret.blobValue),
                };

                let joinTicketKey = '/aurora/services/' + this.getServiceName() + '/realmJoinTickets/' + responseParams.RealmJoinTicket.blobValue.toString('hex');

                return this.store.setJSON(joinTicketKey, joinTicketInfo);
            }, () => {
                return Promise.reject(0x8000012D) //ERROR_WOW_SERVICES_INVALID_REALM_LIST_TICKET
            }).
            then(() => {
                return Promise.resolve(responseParams)
            }, () => {
                return Promise.reject(0x80000075) //ERROR_UTIL_SERVER_UNABLE_TO_GENERATE_JOIN_TICKET
            });
        })
    }

    async validateTicket(ticket, context) {
        const owner = await principal(this.models, this.store, context);
        if (!ticket?.owner || ticket.owner.connectionId !== owner.connectionId || ticket.owner.accountId !== owner.accountId || ticket.owner.address !== owner.address) { throw 0xA; }
        const game = await gameAccount(this.models, owner, ticket.identity.gameAccountId);
        if (game.region !== ticket.identity.gameAccountRegion || (owner.applicationVersion && owner.applicationVersion !== ticket.info.version.versionBuild)) { throw 0xA; }
    }

    registerCommand(command, handler) {
        this.commandHandlers[command] = handler;
    }

    handleCommand(command, params, context) {
        if (Object.hasOwn(this.commandHandlers, command.name)) {
            return this.commandHandlers[command.name](params, command.value, context).then((responseParams) => {
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

    ProcessClientRequest(context) {
        let command = {
            name: '',
            value: null,
            version: '',
            auroraVersion: ''
        };

        let params = {};

        for (let i = 0; i < context.request.attribute.length; i++) {
            let attribute = context.request.attribute[i];

            let parts = attribute.name.split('_');

            switch (parts[0]) {
                case 'Command': {
                    command.name = parts[1];
                    command.version = parts[2];
                    command.auroraVersion = parts[3];

                    if (attribute.value) {
                        command.value = attribute.value;
                    }
                    break;
                }
                case 'Param': {
                    params[parts[1]] = attribute.value;
                    break;
                }
            }
        }

        return this.handleCommand(command, params, context).then((attributes) => {
            context.response.attribute = attributes;
            return Promise.resolve(0);
        });
    }

    async GetAllValuesForAttribute(context) {
        switch (context.request.attributeKey) {
            case 'Command_RealmListRequest_v1_b9': {
                const owner = await principal(this.models, this.store, context);
                const accounts = await this.models.GameAccount.findAll({ where: { accountId: owner.accountId, program: 'WoW' } });
                const regions = new Set(accounts.filter(a => !blocked(a)).map(a => a.region));
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