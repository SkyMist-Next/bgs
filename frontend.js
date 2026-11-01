'use strict';

const net = require('node:net');
const { once } = require('node:events');
const amqplib = require('amqplib');
const createLogger = require('./utils/logger');
const models = require('./models');
const { RedisStore } = require('./utils/redis-store');
const { lifecycle } = require('./utils/lifecycle');
const ConnectionService = require('./services/connection');

// eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
global.logger = createLogger(require('./config/winston.json'));
global.connectionService = new ConnectionService();
const runtime = lifecycle({
    logger: global.logger,
    stop: async () => {
        global.netServer?.close();
        await global.connectionService.drain();
    },
    close: () => Promise.all([global.amqpConnection?.close(), models.sequelize.close(), global.store?.close()]),
    force: () => {
        global.connectionService.closeAllConnections();
        global.amqpConnection?.connection.stream.destroy();
        return global.store?.destroy();
    }
});

async function start() {
    global.store = new RedisStore({ logger: global.logger, onFatal: runtime.shutdown });
    const amqpUrl = 'amqp://' + process.env.RABBITMQ_USERNAME + ':' + process.env.RABBITMQ_PASSWORD + '@' + process.env.RABBITMQ_SERVICE_NAME;
    await Promise.all([
        global.store.connect(), models.sequelize.sync(),
        amqplib.connect(amqpUrl, { timeout: 5000 }).then(async connection => {
            if (runtime.stopping) { await connection.close(); return; }
            global.amqpConnection = connection;
            connection.on('error', runtime.shutdown);
        })
    ]);
    if (runtime.stopping) { return; }
    const accept = socket => global.connectionService.onNewConnection(socket);
    if (process.env.NODE_ENV === 'development') {
        const tls = require('node:tls');
        const fs = require('node:fs');
        global.netServer = tls.createServer({ key: fs.readFileSync('certs/tls.key'), cert: fs.readFileSync('certs/tls.crt') }, accept);
    }
    else { global.netServer = net.createServer(accept); }
    global.netServer.listen(1119);
    await once(global.netServer, 'listening');
    global.netServer.on('error', runtime.shutdown);
    global.logger.info('Listening on port 1119');
}

start().catch(runtime.shutdown);
