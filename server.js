'use strict';

const amqplib = require('amqplib');
const createLogger = require('./utils/logger');
const models = require('./models');
const { RedisStore } = require('./utils/redis-store');
const { lifecycle } = require('./utils/lifecycle');
const ServiceReceiver = require('./messaging/receiver');

// eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
global.logger = createLogger(require('./config/winston.json'));
const runtime = lifecycle({
    logger: global.logger,
    stop: async () => { await global.serviceReceiver?.closeChannel(); },
    close: () => Promise.all([global.amqpConnection?.close(), models.sequelize.close(), global.store?.close()]),
    force: () => { global.amqpConnection?.connection.stream.destroy(); return global.store?.destroy(); }
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
    const Service = require('./services/' + process.argv[2]);
    global.serviceReceiver = new ServiceReceiver(new Service());
    await global.serviceReceiver.start();
}

start().catch(runtime.shutdown);
