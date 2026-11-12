'use strict';

const zlib = require('zlib');
const loadProto = require('../utils/protobuf');

const Service = require('./service.js');
const { RealmJoin } = require('../realm/join');

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

class GameUtilitiesService extends Service {
    constructor({ logger, store, models, realmDirectory }) {
        super('GameUtilitiesService', 'proto/bgs/low/pb/client/game_utilities_service.proto', { logger });
        this.realmJoin = new RealmJoin({ store, models,
            realmDirectory: realmDirectory || new (require('../utils/realm-directory'))(models, models.realmDatabase) });

        this.commandHandlers = {};

        this.registerHandler('ProcessClientRequest', this.ProcessClientRequest.bind(this));

        this.registerHandler('GetAllValuesForAttribute', this.GetAllValuesForAttribute.bind(this));

        this.registerCommand('RealmListTicketRequest', async (params, commandValue, context) => {
            const identity = GetJSON(params.Identity, 'JSONRealmListTicketIdentity');
            const clientInfo = GetJSON(params.ClientInfo, 'JSONRealmListTicketClientInformation');
            const ticket = await this.realmJoin.issueListTicket(context, { gameAccountId: identity.gameAccountID, clientInfo });
            this.logger.debug('Created RealmListRequest');
            return { RealmListTicket: Variant.create({ blobValue: ticket }) };
        });

        this.registerCommand('RealmListRequest', async (params, commandValue, context) => {
            this.logger.debug('Received RealmListRequest');
            const { updates, counts } = await this.realmJoin.listRealms(context, params.RealmListTicket.blobValue, commandValue.stringValue);
            return {
                RealmList: Variant.create({ blobValue: deflateJSONAttributeValue('JSONRealmListUpdates', { updates }) }),
                CharacterCountList: Variant.create({ blobValue: deflateJSONAttributeValue('JSONRealmCharacterCountList', { counts }) })
            };
        });

        this.registerCommand('RealmJoinRequest', async (params, commandValue, context, command = { version: 'v1' }) => {
            const address = params.RealmAddress.uintValue.getLowBitsUnsigned();
            this.logger.debug('Received RealmJoinRequest for realm: ' + address);
            const joined = await this.realmJoin.join(context, params.RealmListTicket.blobValue, address, command.version === 'v0' ? 15595 : 26972);
            return {
                ServerAddresses: Variant.create({ blobValue: deflateJSONAttributeValue('JSONRealmListServerIPAddresses', { families: joined.endpoints }) }),
                RealmJoinTicket: Variant.create({ blobValue: joined.ticket }),
                ...(joined.joinSecret ? { JoinSecret: Variant.create({ blobValue: joined.joinSecret }) } :
                    { RealmAccountName: Variant.create({ stringValue: joined.accountName }), RealmSessionKey: Variant.create({ blobValue: joined.sessionKey }) })
            };
        });
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
        }
        context.response.attribute = await this.handleCommand(command, params, context);
        return 0;
    }

    async GetAllValuesForAttribute(context) {
        switch (context.request.attributeKey) {
            case 'Command_RealmListRequest_v1_b9': {
                for (const subRegion of await this.realmJoin.subRegions(context)) {
                    context.response.attributeValue.push(Variant.create({ stringValue: subRegion }));
                }
                return 0;
            }
            default: {
                return Promise.resolve(0x00000BC7);
            }
        }
    }
}

module.exports = GameUtilitiesService;
