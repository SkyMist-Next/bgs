/**
 * Created by kaloyan on 6.7.2016 г..
 */
'use strict';

const net = require('net');
const amqplib = require('amqplib');
const winston = require('winston');
const models = require('./models');
const { Etcd3 } = require('etcd3');
const ConnectionService = require('./services/connection');

const winstonFileTransportConfig = require('./config/winston.json');
const winstonFileTransport = new winston.transports.File(winstonFileTransportConfig);
let winstonTransports = [winstonFileTransport];

if (process.env.NODE_ENV === 'development') {
    const winstonConsoleTransport = new winston.transports.Console({
        level: 'debug',
        handleExceptions: true,
        json: false,
        colorize: true
    });

    winstonTransports.push(winstonConsoleTransport);
}

winston.emitErrs = true;

global.amqpConnection = null;
global.netServer = null;
global.connectionService = new ConnectionService();
global.logger = new winston.Logger({transports: winstonTransports, exitOnError: false});
global.etcd3 = new Etcd3({hosts: process.env.ETCD_HOST});

let amqpUrl = 'amqp://' + process.env.RABBITMQ_USERNAME + ':' + process.env.RABBITMQ_PASSWORD + '@' + process.env.RABBITMQ_SERVICE_NAME;

let promises = [];

process.on('unhandledRejection', (error) => {
    global.logger.error(error);
    process.exit(1);
});

process.on('SIGINT', () => {
    global.connectionService.closeAllConnections();

    if (global.netServer) {
        global.netServer.close();
    }
});

promises.push(amqplib.connect(amqpUrl));
promises.push(models.sequelize.sync());

Promise.all(promises).then(([conn, db]) => {
    global.amqpConnection = conn;

    if (process.env.NODE_ENV === 'development') {
        const tls = require('tls');
        const fs = require('fs');

        global.netServer = tls.createServer({
            key: fs.readFileSync('certs/tls.key'),
            cert: fs.readFileSync('certs/tls.crt')
        }, (socket) => {
            global.connectionService.onNewConnection(socket);
        });
    }
    else {
        global.netServer = net.createServer((socket) => {
            global.connectionService.onNewConnection(socket);
        });
    }

    global.netServer.listen(1119, () => {
        global.logger.info('Listening on port 1119');
    });

    global.netServer.on('close', () => {
        global.etcd3.close();

        if (global.amqpConnection) {
            global.amqpConnection.close();
        }
    });
});
