'use strict';

const http = require('node:http');
const { once } = require('node:events');
const createRestApp = require('./utils/rest-app');
const createLogger = require('./utils/logger');
const { RedisStore } = require('./utils/redis-store');
const { lifecycle, readiness } = require('./utils/lifecycle');
const models = require('./models');

// eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
global.logger = createLogger(require('./config/winston.json'));
let server;
let started = false;
const runtime = lifecycle({
    logger: global.logger,
    stop: async () => {
        started = false;
        if (server) { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    },
    close: () => Promise.all([global.store?.close(), models.sequelize.close()]),
    force: () => { server?.closeAllConnections(); return global.store?.destroy(); }
});

async function start() {
    global.store = new RedisStore({ logger: global.logger, onFatal: runtime.shutdown });
    const app = createRestApp({
        models, store: global.store, logger: global.logger,
        isReady: readiness({ store: global.store, sequelize: models.sequelize, isStarted: () => started && !runtime.stopping }),
        isAccepting: () => started && !runtime.stopping && global.store.healthy
    });
    if (process.env.NODE_ENV === 'development') {
        const https = require('node:https');
        const fs = require('node:fs');
        server = https.createServer({ key: fs.readFileSync('certs/tls.key'), cert: fs.readFileSync('certs/tls.crt') }, app);
        server.listen(443);
    }
    else { server = http.createServer(app).listen(80); }
    await once(server, 'listening');
    await Promise.all([global.store.connect(), models.sequelize.sync()]);
    if (runtime.stopping) { return; }
    const webAuthUrl = process.env.WEB_AUTH_URL || (process.env.NODE_ENV === 'development' ? 'https://127.0.0.1:443/bnetserver/login/' : undefined);
    if (webAuthUrl) {
        const url = new URL(webAuthUrl);
        if (!['http:', 'https:'].includes(url.protocol) || !webAuthUrl.endsWith('/')) { throw new Error('Invalid WEB_AUTH_URL'); }
        await global.store.setMetadata('/aurora/services/AuthenticationService/WebAuthUrl', webAuthUrl);
    }
    started = true;
    global.logger.info('REST Service listening');
}

start().catch(runtime.shutdown);
