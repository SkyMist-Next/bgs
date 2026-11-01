'use strict';
const appRoot = require('app-root-path');
const FourCC = require(appRoot + '/utils/fourcc');
const Long = require('long');
const protobuf = require('protobufjs');

const entityTypes = protobuf.loadSync('proto/bgs/low/pb/client/entity_types.proto');
const entityId = entityTypes.lookupType('bgs.protocol.EntityId');

module.exports = (sequelize, DataTypes) => {
    let GameAccount = sequelize.define('GameAccount', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        region: { type: DataTypes.TINYINT, allowNull: false },
        program: { type: DataTypes.CHAR(4), allowNull: false },
        displayName: { type: DataTypes.STRING, allowNull: false, field: 'display_name' },
        isBanned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'banned' },
        isSuspended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'suspended' },
        accountId: { type: DataTypes.BIGINT, allowNull: false, field: 'account_id' },
        expansion: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 6 },
        billingPlan: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0, field: 'billing_plan' },
        billingTimeRemaining: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0, field: 'billing_time_remaining' },
        tutorialData: { type: DataTypes.BLOB('tiny'), allowNull: true, field: 'tutorial_data' }
        }, {
        getterMethods: {
            entityId() {
                let id = entityId.create();
                let programId = new FourCC(this.program);

                id.low = Long.fromString(this.id, true);
                id.high = Long.fromBits(programId.getIntValue(), (0x2 << 24) | (this.region & 0xFF), true);

                return id;
            }
        },
        timestamps: true,
        underscored: true,
        tableName: 'game_accounts'
    });

    GameAccount.associate = (models) => {
        GameAccount.belongsTo(models.Account, { foreignKey: 'account_id', targetKey: 'id'});
    };

    return GameAccount;
};