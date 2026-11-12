'use strict';
const Long = require('long');
const loadProto = require('../utils/protobuf');

const entityTypes = loadProto('proto/bgs/low/pb/client/entity_types.proto');
const entityId = entityTypes.lookupType('bgs.protocol.EntityId');

module.exports = (sequelize, DataTypes) => {
    let Account = sequelize.define('Account', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        email: { type: DataTypes.STRING, allowNull: false },
        hash: { type: DataTypes.STRING, allowNull: false },
        wowLicenseIndexHighWater: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'wow_license_index_high_water' },
        battleTag: { type: DataTypes.STRING, allowNull: false, field: 'battle_tag' },
        givenName: { type: DataTypes.STRING(255), allowNull: true, field: 'given_name' },
        surname: { type: DataTypes.STRING(255), allowNull: true },
        realIdEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'real_id_enabled' },
        banExpiresAt: { type: DataTypes.DATE, field: 'ban_expires_at' },
        banReason: { type: DataTypes.STRING(1024), field: 'ban_reason' },
        isBanned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'banned' },
        isSuspended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'suspended' }
    }, {
        getterMethods: {
            entityId() {
                let id = entityId.create();

                id.low = Long.fromString(String(this.id), true);
                id.high = Long.fromBits(0, (0x1 << 24), true);

                return id;
            }
        },

        timestamps: true,
        underscored: true,
        tableName: 'accounts'
    });

    Account.associate = (models) => {
        Account.hasMany(models.GameAccount, {as: 'gameAccounts', foreignKey: 'accountId', sourceKey: 'id'});
    };

    return Account;
};
