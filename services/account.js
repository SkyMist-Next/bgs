'use strict';

const loadProto = require('../utils/protobuf');

const Service = require('./service');

const accountTypes = loadProto('proto/bgs/low/pb/client/account_types.proto');

const AccountState = accountTypes.lookupType('bgs.protocol.account.v1.AccountState');
const AccountTags = accountTypes.lookupType('bgs.protocol.account.v1.AccountFieldTags');
const PrivacyInfo = accountTypes.lookupType('bgs.protocol.account.v1.PrivacyInfo');
const GameAccountState = accountTypes.lookupType('bgs.protocol.account.v1.GameAccountState');
const GameAccountTags = accountTypes.lookupType('bgs.protocol.account.v1.GameAccountFieldTags');
const GameLevelInfo = accountTypes.lookupType('bgs.protocol.account.v1.GameLevelInfo');
const GameStatus = accountTypes.lookupType('bgs.protocol.account.v1.GameStatus');

const models = require('../models');

class AccountService extends Service{
    constructor() {
        super('AccountService', 'proto/bgs/low/pb/client/account_service.proto');

        this.registerHandler('GetAccountState', this.GetAccountStatus.bind(this));

        this.registerHandler('GetGameAccountState', this.GetGameAccountStatus.bind(this));
    }

    GetAccountStatus(context) {
        global.logger.debug('Received GetAccountStatus for accountId:' + context.request.entityId.low.toString());

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

    GetGameAccountStatus(context) {
        global.logger.debug('Received GetGameAccountStatus for gameAccountId:' + context.request.gameAccountId.low.toString());

        context.response.state = GameAccountState.create();
        context.response.tags = GameAccountTags.create();

        return models.GameAccount.findByPk(context.request.gameAccountId.low.toString()).
        then((gameAccount) => {
            if(Object.hasOwn(context.request.options, 'fieldGameLevelInfo')) {
                context.response.state.gameLevelInfo = GameLevelInfo.create();
                context.response.state.gameLevelInfo.name = gameAccount.displayName;
                context.response.state.gameLevelInfo.program = gameAccount.entityId.high.getLowBitsUnsigned();

                context.response.tags.gameLevelInfoTag = 0x5C46D483;
            }

            if(Object.hasOwn(context.request.options, 'fieldGameStatus')) {
                context.response.state.gameStatus = GameStatus.create();
                context.response.state.gameStatus.name = gameAccount.displayName;
                context.response.state.gameStatus.program = gameAccount.entityId.high.getLowBitsUnsigned();
                context.response.state.gameStatus.isBanned = gameAccount.isBanned;
                context.response.state.gameStatus.isSuspended = gameAccount.isSuspended;

                context.response.tags.gameStatusTag = 0x98B75F99;
            }

            return Promise.resolve(0);
        });
    }
}

module.exports = AccountService;