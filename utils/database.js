'use strict';

const Sequelize = require('sequelize');
const defineAccount = require('../models/account');
const defineGameAccount = require('../models/gameaccount');

module.exports = function createDatabase(config, logger, environment = process.env) {
    const options = { ...config, logging: message => logger.debug(message) };
    delete options.syncOnStart;
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
    const connections = new Set();
    let forced = false;
    sequelize.addHook('afterConnect', 'serverOwnership', connection => {
        if (forced) {
            connection.destroy();
            throw new Error('Database connected after forced shutdown');
        }
        connections.add(connection);
    });
    sequelize.addHook('afterDisconnect', 'serverOwnership', connection => connections.delete(connection));
    const forceClose = async () => {
        forced = true;
        // Pool destruction alone only closes idle connections. In-flight MySQL
        // sockets must also be interrupted when graceful draining expires.
        const results = await Promise.allSettled([...connections].map(connection => Promise.resolve().then(() => connection.destroy())));
        connections.clear();
        await sequelize.connectionManager.pool.destroyAllNow();
        const failed = results.find(result => result.status === 'rejected');
        if (failed) { throw failed.reason; }
    };
    return { ...db, sequelize, Sequelize, forceClose };
};
