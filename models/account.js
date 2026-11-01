'use strict';
const Long = require('long');
const protobuf = require('protobufjs');

const entityTypes = protobuf.loadSync('proto/bgs/low/pb/client/entity_types.proto');
const entityId = entityTypes.lookupType('bgs.protocol.EntityId');

module.exports = (sequelize, DataTypes) => {
    let Account = sequelize.define('Account', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        email: { type: DataTypes.STRING, allowNull: false },
        hash: { type: DataTypes.STRING, allowNull: false },
        battleTag: { type: DataTypes.STRING, allowNull: false, field: 'battle_tag' },
        isBanned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'banned' },
        isSuspended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'suspended' }
    }, {
        getterMethods: {
            entityId() {
                let id = entityId.create();

                id.low = Long.fromString(this.id, true);
                id.high = Long.fromBits(0, (0x1 << 24), true);

                return id;
            }
        },

        timestamps: true,
        underscored: true,
        tableName: 'accounts'
    });

    Account.associate = (models) => {
        Account.hasMany(models.GameAccount, {as: 'gameAccounts', foreignKey: 'account_id', sourceKey: 'id'});
    };

    return Account;
};