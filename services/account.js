'use strict';

const loadProto = require('../utils/protobuf');

const Service = require('./service');
const { principal, banned, blocked } = require('../utils/admin-state');
const { realmAccountName } = require('../utils/wow-license');

const accountTypes = loadProto('proto/bgs/low/pb/client/account_types.proto');

const AccountState = accountTypes.lookupType('bgs.protocol.account.v1.AccountState');
const AccountTags = accountTypes.lookupType('bgs.protocol.account.v1.AccountFieldTags');
const PrivacyInfo = accountTypes.lookupType('bgs.protocol.account.v1.PrivacyInfo');
const GameAccountState = accountTypes.lookupType('bgs.protocol.account.v1.GameAccountState');
const GameAccountTags = accountTypes.lookupType('bgs.protocol.account.v1.GameAccountFieldTags');
const GameLevelInfo = accountTypes.lookupType('bgs.protocol.account.v1.GameLevelInfo');
const GameStatus = accountTypes.lookupType('bgs.protocol.account.v1.GameStatus');


class AccountService extends Service{
    constructor({ logger, models, store }) {
        super('AccountService', 'proto/bgs/low/pb/client/account_service.proto', { logger });
        this.models = models;
        this.store = store;

        this.registerHandler('GetAccountState', this.GetAccountStatus.bind(this));

        this.registerHandler('GetGameAccountState', this.GetGameAccountStatus.bind(this));
    }

    async GetAccountStatus(context) {
        const owner = await principal(this.models, this.store, context);
        if (context.request.entityId.low.toString() !== owner.accountId) { throw 0xA; }
        this.logger.debug('Received GetAccountStatus for accountId:' + context.request.entityId.low.toString());

        context.response.state = AccountState.create();
        context.response.tags = AccountTags.create();

        if (Object.hasOwn(context.request, 'fieldPrivacyInfo')) {
            context.response.state.privacyInfo = PrivacyInfo.create();
            context.response.state.privacyInfo.isUsingRid = false;
            context.response.state.privacyInfo.isReadIdVisibleForViewFriends = false;
            context.response.state.privacyInfo.isHiddenFromFriendFinder = true;

            context.response.tags.privacyInfoTag = 0xD7CA834D;
        }

        return Promise.resolve(0);
    }

    async GetGameAccountStatus(context) {
        const owner = await principal(this.models, this.store, context);
        this.logger.debug('Received GetGameAccountStatus for gameAccountId:' + context.request.gameAccountId.low.toString());

        context.response.state = GameAccountState.create();
        context.response.tags = GameAccountTags.create();

        return this.models.GameAccount.findByPk(context.request.gameAccountId.low.toString()).
        then((gameAccount) => {
            if (!gameAccount || String(gameAccount.accountId) !== owner.accountId) { throw 0xA; }
            let name = gameAccount.displayName;
            if (owner.applicationVersion === 15595) {
                if (blocked(gameAccount) || gameAccount.program !== 'WoW' || gameAccount.expansion !== 3 ||
                    context.request.gameAccountId.high.toString() !== gameAccount.entityId.high.toString()) { throw 0xA; }
                try { name = realmAccountName(gameAccount.accountId, gameAccount.wowLicenseIndex); }
                catch { throw 0xA; }
            }
            if(Object.hasOwn(context.request.options, 'fieldGameLevelInfo')) {
                context.response.state.gameLevelInfo = GameLevelInfo.create();
                context.response.state.gameLevelInfo.name = name;
                context.response.state.gameLevelInfo.program = gameAccount.entityId.high.getLowBitsUnsigned();

                context.response.tags.gameLevelInfoTag = 0x5C46D483;
            }

            if(Object.hasOwn(context.request.options, 'fieldGameStatus')) {
                context.response.state.gameStatus = GameStatus.create();
                context.response.state.gameStatus.name = gameAccount.displayName;
                context.response.state.gameStatus.program = gameAccount.entityId.high.getLowBitsUnsigned();
                context.response.state.gameStatus.isBanned = banned(gameAccount);
                context.response.state.gameStatus.isSuspended = gameAccount.isSuspended;

                context.response.tags.gameStatusTag = 0x98B75F99;
            }

            return Promise.resolve(0);
        });
    }
}

module.exports = AccountService;