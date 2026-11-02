'use strict';

function configuration(kind, env = process.env) {
    const environment = env.NODE_ENV || 'development';
    // eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
    const database = require('../config/database.json')[environment];
    return {
        env, environment: env.NODE_ENV, database,
        port: Number(env.BGS_PORT || (kind === 'rest' ? (env.NODE_ENV === 'development' ? 443 : 80) : 1119)),
        healthPort: env.BGS_HEALTH_PORT ? Number(env.BGS_HEALTH_PORT) : undefined,
        tlsEnabled: env.BGS_TLS === undefined ? env.NODE_ENV === 'development' : env.BGS_TLS === 'true',
        webAuthUrl: env.WEB_AUTH_URL || (env.NODE_ENV === 'development' ? 'https://127.0.0.1:443/bnetserver/login/' : undefined),
        amqpUrl: 'amqp://' + encodeURIComponent(env.RABBITMQ_USERNAME) + ':' +
            encodeURIComponent(env.RABBITMQ_PASSWORD) + '@' + env.RABBITMQ_SERVICE_NAME
    };
}

function tlsOptions(config) {
    if (config.tls) { return config.tls; }
    const fs = require('node:fs');
    return { key: fs.readFileSync('certs/tls.key'), cert: fs.readFileSync('certs/tls.crt') };
}

function logger() {
    // eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
    return require('../utils/logger')(require('../config/winston.json'));
}

module.exports = { configuration, tlsOptions, logger };
