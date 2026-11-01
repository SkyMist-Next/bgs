'use strict';

const bcrypt = require('bcrypt');
const express = require('express');
const morgan = require('morgan');

module.exports = function createRestApp({ models, etcd, logger, isReady, compare = bcrypt.compare }) {
    const rest = express();
    rest.use(express.json());
    rest.use(express.urlencoded({ extended: true }));
    rest.use(morgan('combined', { stream: { write: message => logger.info(message.trimEnd()) } }));

    rest.get('/alive', (req, res) => res.sendStatus(200));
    rest.get('/ready', (req, res) => res.sendStatus(isReady() ? 200 : 500));

    rest.get('/bnetserver/login/:loginTicket', (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json({
            'type': 1,
            'inputs': [{
                'input_id': 'account_name',
                'type': 'text',
                'label': 'E-mail',
                'max_length': 320
            }, {
                'input_id': 'password',
                'type': 'password',
                'label': 'Password',
                'max_length': 16
            }, {
                'input_id': 'log_in_submit',
                'type': 'submit',
                'label': 'Log In'
            }]
        });
    });

    rest.post('/bnetserver/login/:loginTicket', async (req, res) => {
        const inputs = req.body && req.body.inputs;
        if (!Array.isArray(inputs) || inputs.some(input =>
            !input || typeof input !== 'object' || typeof input.input_id !== 'string')) {
            return res.sendStatus(400);
        }
        const names = inputs.filter(input => input.input_id === 'account_name');
        const passwords = inputs.filter(input => input.input_id === 'password');
        if (names.length !== 1 || passwords.length !== 1 ||
            typeof names[0].value !== 'string' || typeof passwords[0].value !== 'string' ||
            !names[0].value || !passwords[0].value) {
            return res.sendStatus(400);
        }

        const path = '/aurora/services/AuthenticationService/loginTickets/' + req.params.loginTicket;
        const ticket = await etcd.get(path).string();
        if (!ticket) {
            return res.sendStatus(500);
        }
        const account = await models.Account.findOne({ where: { email: names[0].value } });
        if (!account || !await compare(passwords[0].value, account.hash)) {
            return res.json({ authentication_state: 'LOGIN' });
        }
        const lease = etcd.lease(30);
        await lease.put(path + '/accountId').value(account.id).exec();
        return res.json({ login_ticket: ticket, authentication_state: 'DONE' });
    });

    // Express 5 forwards rejected async handlers here, including dependency failures.
    rest.use((error, req, res, next) => {
        if (res.headersSent) {
            return next(error);
        }
        if (error instanceof URIError || error.type === 'entity.parse.failed' || error.type === 'request.aborted' ||
            error.type === 'request.size.invalid') {
            return res.sendStatus(400);
        }
        if (error.type === 'entity.too.large') {
            return res.sendStatus(413);
        }
        if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
            return res.sendStatus(415);
        }
        logger.error(error);
        return res.sendStatus(500);
    });
    return rest;
};
