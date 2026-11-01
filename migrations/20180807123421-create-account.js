'use strict';
module.exports = {
    up: (queryInterface, Sequelize) => {
        return queryInterface.createTable('accounts', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.BIGINT
            },
            email: {
                type: Sequelize.STRING,
                allowNull: false,
            },
            hash: {
                type: Sequelize.STRING,
                allowNull: false,
            },
            battle_tag: {
                type: Sequelize.STRING,
                allowNull: false
            },
            isBanned: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
                field: 'banned'
            },
            isSuspended: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
                field: 'suspended'
            },
            created_at: {
                allowNull: false,
                type: Sequelize.DATE
            },
            updated_at: {
                allowNull: false,
                type: Sequelize.DATE
            }
        }, {
            underscored: true,
            timestamps: true
        });
    },
    down: (queryInterface) => {
        return queryInterface.dropTable('Accounts');
    }
};