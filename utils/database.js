'use strict';

const Sequelize = require('sequelize');
const defineAccount = require('../models/account');
const defineGameAccount = require('../models/gameaccount');

module.exports = function createDatabase(config, logger, environment = process.env) {
    const options = { ...config, logging: message => logger.debug(message) };
    const variable = config.use_env_variable || config.use_env_letiable;
    const sequelize = variable
        ? new Sequelize(environment[variable], options)
        : new Sequelize(config.database, config.username, config.password, options);
    const db = {
        Account: defineAccount(sequelize, Sequelize.DataTypes),
        GameAccount: defineGameAccount(sequelize, Sequelize.DataTypes)
    };
    for (const model of Object.values(db)) {
        model.associate(db);
    }
    return { ...db, sequelize, Sequelize };
};
