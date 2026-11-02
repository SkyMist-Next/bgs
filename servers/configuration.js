'use strict';

function configuration(kind, env = process.env) {
    if (env.BGS_IP_BANS_ENABLED !== undefined && !['true', 'false'].includes(env.BGS_IP_BANS_ENABLED)) { throw new Error('BGS_IP_BANS_ENABLED must be true or false'); }
    const environment = env.NODE_ENV || 'development';
    // eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
    const database = require('../config/database.json')[environment];
    return {
        realmDatabase: env.BGS_REALM_DATABASE || 'skymist_operator',
        ipBansEnabled: env.BGS_IP_BANS_ENABLED === 'true',
        env, environment: env.NODE_ENV, database,
        proxyProtocol: env.BGS_PROXY_PROTOCOL === 'v2',
        trustedProxyCIDRs: JSON.parse(env.BGS_TRUSTED_PROXY_CIDRS || '[]'),
        trustedHttpProxyCIDRs: JSON.parse(env.BGS_TRUSTED_HTTP_PROXY_CIDRS || '[]'),
        port: Number(env.BGS_PORT || (kind === 'rest' ? (env.NODE_ENV === 'development' ? 443 : 80) : 1119)),
        tlsCertFile: env.BGS_TLS_CERT_FILE, tlsKeyFile: env.BGS_TLS_KEY_FILE,
        tlsServerName: env.BGS_TLS_SERVER_NAME,
        healthPort: env.BGS_HEALTH_PORT ? Number(env.BGS_HEALTH_PORT) : undefined,
        tlsEnabled: env.BGS_TLS === undefined ? env.NODE_ENV === 'development' : env.BGS_TLS === 'true',
        webAuthUrl: env.WEB_AUTH_URL || (env.NODE_ENV === 'development' ? 'https://127.0.0.1:443/bnetserver/login/' : undefined),
        amqpUrl: 'amqp://' + encodeURIComponent(env.RABBITMQ_USERNAME) + ':' +
            encodeURIComponent(env.RABBITMQ_PASSWORD) + '@' + env.RABBITMQ_SERVICE_NAME
    };
}

function logger() {
    // eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
    return require('../utils/logger')(require('../config/winston.json'));
}

module.exports = { configuration, logger };
