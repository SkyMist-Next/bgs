'use strict';

const bcrypt = require('bcrypt');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');
const morgan = require('morgan');
const { Etcd3 } = require('etcd3');
const models = require('./models');

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

global.logger = new winston.Logger({transports: winstonTransports, exitOnError: false});
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

const rest = express();

rest.use(bodyParser.json());
rest.use(bodyParser.urlencoded({ extended: true }));
rest.use(morgan('combined', { stream: { write: message => global.logger.info(message) }}));

rest.get('/alive', (req, res) => {
    res.sendStatus(200);
});

rest.get('/ready', (req, res) => {
    ready ? res.sendStatus(200) : res.sendStatus(500);
});

rest.get('/bnetserver/login/:loginTicket', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
        "type": 1,
        "inputs": [{
            "input_id": "account_name",
            "type": "text",
            "label": "E-mail",
            "max_length": 320
        }, {
            "input_id": "password",
            "type": "password",
            "label": "Password",
            "max_length": 16
        }, {
            "input_id": "log_in_submit",
            "type": "submit",
            "label": "Log In"
        }]
    });
});

rest.post('/bnetserver/login/:loginTicket', (req, res) => {
    let username = null;
    let password = null;

    res.setHeader('Content-Type', 'application/json');
    req.body.inputs.forEach(function (input) {
        if (input.input_id === 'account_name')
            username = input.value;

        if (input.input_id === 'password')
            password = input.value;
    });

    if (req.params.hasOwnProperty('loginTicket')) {
        let loginTicketPath = '/aurora/services/AuthenticationService/loginTickets/' + req.params.loginTicket;

        let loginResult = {};

        global.etcd3.get(loginTicketPath).string().then((loginTicket) => {
            if (loginTicket) {
                if (username && password) {
                    return models.Account.findOne({where: {email: username}}).then((account) => {
                        if (account) {
                            if(bcrypt.compareSync(password, account.hash)) {
                                let loginTicketLease = global.etcd3.lease(30);
                                return loginTicketLease.put(loginTicketPath + '/accountId').value(account.id).exec();
                            }
                            else {
                                return Promise.reject('Invalid password for account: ' + username);
                            }
                        }
                        else {
                            return Promise.reject('No account found: ' + username);
                        }
                    }).
                    then(() => {
                        loginResult.login_ticket = loginTicket;
                        return Promise.resolve('DONE');
                    }).
                    catch((error) => {
                        global.logger.error(error);
                        return Promise.resolve('LOGIN');
                    });
                }
            }
            else {
                return Promise.reject('No such login ticket exists');
            }
        }).
        then((state) => {
            loginResult.authentication_state = state;
            res.json(loginResult);
        }).
        catch(() => {
            res.sendStatus(500);
        });
    }
    else {
        res.sendStatus(400);
    }

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
