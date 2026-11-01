'use strict';

const http = require('http');
const createRestApp = require('./utils/rest-app');
const createLogger = require('./utils/logger');
const { Etcd3 } = require('etcd3');
const models = require('./models');

// eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
global.logger = createLogger(require('./config/winston.json'));
global.etcd3 = new Etcd3({hosts: process.env.ETCD_HOST});

let ready = false;

process.on('unhandledRejection', (error) => {
    global.logger.error(error);
    process.exit(1);
});

process.on('SIGINT', () => {
    ready = false;

    global.etcd3.close();
});

const rest = createRestApp({
    models,
    etcd: global.etcd3,
    logger: global.logger,
    isReady: () => ready
});

models.sequelize.sync().then(() => {
    global.logger.debug('Database synced');
    ready = true;
});

if(process.env.NODE_ENV === 'development') {
    const https = require('https');
    const fs = require('fs');

    https.createServer({
        key: fs.readFileSync('certs/tls.key'),
        cert: fs.readFileSync('certs/tls.crt')
    }, rest).listen(443);

    global.etcd3.put('/aurora/services/AuthenticationService/WebAuthUrl').value('https://127.0.0.1:443/bnetserver/login/').then(() => {
        global.logger.info('REST Service listening');
    });
}
else {
    http.createServer(rest).listen(80, () => {
        //TODO add a method to dynamically retrieve the external address of the service
        //global.etcd.set('/aurora/services/AuthenticationService/WebAuthUrl', 'https://127.0.0.1:443/bnetserver/login/');
        global.logger.info('REST Service listening');
    });
}
