'use strict';

const Sequelize = require('sequelize');
const defineAccount = require('../models/account');
const defineGameAccount = require('../models/gameaccount');

module.exports = function createDatabase(config, logger, environment = process.env) {
    const options = { ...config, timezone: '+00:00', logging: message => logger.debug(message) };
    if (options.dialect === 'mysql') {
        // Keep JSON text and BIGINT values lossless across MySQL's JSON type
        // and MariaDB's JSON alias, including JSON string primitives.
        options.dialectOptions = { ...options.dialectOptions, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true };
    }
    delete options.syncOnStart;
    const variable = config.use_env_variable || config.use_env_letiable;
    const sequelize = variable
        ? new Sequelize(environment[variable], options)
        : new Sequelize(config.database, config.username, config.password, options);
    const db = {
        Account: defineAccount(sequelize, Sequelize.DataTypes),
        GameAccount: defineGameAccount(sequelize, Sequelize.DataTypes),
        IPBan: require('../models/ipban')(sequelize, Sequelize.DataTypes),
        GameAccountPrivilege: require('../models/gameaccountprivilege')(sequelize, Sequelize.DataTypes),
        ...require('../models/realmgameplay')(sequelize, Sequelize.DataTypes)
    };
    for (const model of Object.values(db)) {
        model.associate?.(db);
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
