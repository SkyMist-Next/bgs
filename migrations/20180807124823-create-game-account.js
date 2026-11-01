'use strict';
module.exports = {
    up: (queryInterface, Sequelize) => {
        return queryInterface.createTable('game_accounts', {
            id: {
                allowNull: false, 
                autoIncrement: true, 
                primaryKey: true, 
                type: Sequelize.BIGINT
            }, 
            region: { 
                type: Sequelize.TINYINT, 
                allowNull: false 
            }, 
            program: { 
                type: Sequelize.CHAR(4), 
                allowNull: false 
            }, 
            displayName: { 
                type: Sequelize.STRING, 
                allowNull: false, 
                field: 'display_name' 
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
            timestamps: true,
            freezeTableName: true,
            tableName: 'game_accounts'
        });
    }, 
    down: (queryInterface) => {
        return queryInterface.dropTable('game_accounts');
    }
};