'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const loadProto = require('../utils/protobuf');

const Service = require('./service.js');

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
    return  ((Number.parseInt(parts[0], 10) & 0xFF) << 24) |
            ((Number.parseInt(parts[1], 10) & 0xFF) << 16) |
            (Number.parseInt(parts[2], 10) & 0xFF);
}

function bufferToArray(buffer) {
    let array = [];
    for (const value of buffer) {
        array.push(value);
    }

    return array;
}

class GameUtilitiesService extends Service {
    constructor() {
        super('GameUtilitiesService', 'proto/bgs/low/pb/client/game_utilities_service.proto');

        this.commandHandlers = {};

        this.registerHandler('ProcessClientRequest', this.ProcessClientRequest.bind(this));

        this.registerHandler('GetAllValuesForAttribute', this.GetAllValuesForAttribute.bind(this));

        this.registerCommand('RealmListTicketRequest', (params) => {
            let identity = GetJSON(params.Identity, 'JSONRealmListTicketIdentity');
            let clientInfo = GetJSON(params.ClientInfo, 'JSONRealmListTicketClientInformation');

            let listTicket = crypto.randomBytes(20);
            let listTicketKey = '/aurora/services/' + this.getServiceName() + '/realmListTickets/' + listTicket.toString('hex');

            let listTicketInfo = {
                info: clientInfo.info,
                identity: identity
            };

            global.logger.debug('Created RealmListRequest with listTicket: ' + listTicket.toString('hex'));

            return global.etcd3.put(listTicketKey).value(JSON.stringify(listTicketInfo)).then(() => {
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

        this.registerCommand('RealmListRequest', (params, commandValue) => {
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

            global.logger.debug('Received RealmListRequest with listTicket: ' + listTicket);

            return global.etcd3.getAll().prefix(realmsPrefix).json().
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
                    realmEntry.update.populationState = 1;
                    realmEntry.update.flags = 0;

                    if (realms[virtualRealmAddressKey].isHidden)
                        realmEntry.update.flags |= 0x2;

                    if (realms[virtualRealmAddressKey].isTournament)
                        realmEntry.update.flags |= 0x4;

                    realmEntry.deleting = realms[virtualRealmAddressKey].deleting;

                    realmListUpdates.push(realmEntry);
                });

                return global.etcd3.get(listTicketPath).json();
            }, () => {
                return Promise.reject(0x8000006D) //ERROR_UTIL_SERVER_MISSING_REALM_LIST
            }).
            then((listTicketInfo) => {
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

        this.registerCommand('RealmJoinRequest', (params, commandValue) => {
            let subRegion = commandValue.stringValue;
            let listTicket = params.RealmListTicket.blobValue.toString('hex');
            let realmAddress = realmAddressToString(params.RealmAddress.uintValue.getLowBitsUnsigned());

            global.logger.debug('Received RealmJoinRequest for realm: ' + realmAddress);

            let responseParams = {
                ServerAddresses: Variant.create(),
                RealmJoinTicket: Variant.create(),
                JoinSecret: Variant.create()
            };

            return global.etcd3.get('/aurora/services/WoWService/subRegions/' + subRegion + '/virtualRealms/' + realmAddress).json().
            then((virtualRealm) => {
                return global.etcd3.get('/aurora/services/WoWService/subRegions/' + subRegion + '/gameServers/' + virtualRealm.gameServerId).json()
            }, () => {
                return Promise.reject(0x8000006B) //ERROR_UTIL_SERVER_MISSING_VIRTUAL_REALM
            }).
            then((gameServer) => {
                responseParams.ServerAddresses.blobValue = deflateJSONAttributeValue('JSONRealmListServerIPAddresses', { families: gameServer.endpoints});
                return global.etcd3.get('/aurora/services/' + this.getServiceName() + '/realmListTickets/' + listTicket).json();
            }, () => {
                return Promise.reject(0x8000012F) //ERROR_WOW_SERVICES_INVALID_SERVER_ADDRESSES
            }).
            then((listTicketInfo) => {
                responseParams.RealmJoinTicket.blobValue = crypto.randomBytes(20);
                responseParams.JoinSecret.blobValue = crypto.randomBytes(32);

                let joinTicketInfo = {
                    subRegion: subRegion,
                    realmAddress: realmAddress,
                    gameAccount: listTicketInfo.identity,
                    clientSecret: listTicketInfo.info.secret,
                    joinSecret: bufferToArray(responseParams.JoinSecret.blobValue),
                };

                let joinTicketKey = '/aurora/services/' + this.getServiceName() + '/realmJoinTickets/' + responseParams.RealmJoinTicket.blobValue.toString('hex');

                return global.etcd3.put(joinTicketKey).value(JSON.stringify(joinTicketInfo)).exec();
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

    registerCommand(command, handler) {
        this.commandHandlers[command] = handler;
    }

    handleCommand(command, params) {
        if (Object.hasOwn(this.commandHandlers, command.name)) {
            return this.commandHandlers[command.name](params, command.value).then((responseParams) => {
                let attributes = [];
                Object.getOwnPropertyNames(responseParams).forEach((responseParamName) => {
                    let attribute = Attribute.create();
                    attribute.name = 'Param_' + responseParamName;
                    attribute.value = responseParams[responseParamName];
                    attributes.push(attribute);
                });

                return Promise.resolve(attributes);
            }, (error) => {
                global.logger.error('Error: '+ error + ' in command: ' + command.name);
                return Promise.reject(error);
            });
        }
        else {
            //reject with unknown command ?
            global.logger.error('Unknown command: ' + command.name + ' received from client');
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

        return this.handleCommand(command, params).then((attributes) => {
            context.response.attribute = attributes;
            return Promise.resolve(0);
        });
    }

    GetAllValuesForAttribute(context) {
        switch (context.request.attributeKey) {
            case 'Command_RealmListRequest_v1_b9': {
                let subRegionPrefix = '/aurora/services/WoWService/subRegions';
                return global.etcd3.getAll().prefix(subRegionPrefix).keys().then((subRegionKeys) => {
                    subRegionKeys.forEach((subRegionKey) => {
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