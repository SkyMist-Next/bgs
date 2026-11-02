'use strict';

const bcrypt = require('bcrypt');
const express = require('express');
const { blocked, checkIP } = require('./admin-state');

module.exports = function createRestApp({ models, store, logger, isReady, isAccepting = () => true, compare = bcrypt.compare, track = operation => operation(), trustedProxyCIDRs = [], exposeHealth = true }) {
    const rest = express();
    rest.use((req, res, next) => {
        const started = process.hrtime.bigint();
        let logged = false;
        const logRequest = () => {
            if (logged) { return; }
            logged = true;
            // Only log route templates: raw paths and query strings can contain tickets.
            logger.info('REST request', {
                method: req.method,
                route: req.route?.path || 'unmatched',
                address: req.ip,
                status: res.statusCode,
                durationMs: Number(process.hrtime.bigint() - started) / 1e6,
                aborted: !res.writableFinished
            });
        };
        res.once('finish', logRequest);
        res.once('close', logRequest);
        next();
    });
    rest.use(express.json());
    rest.use(express.urlencoded({ extended: true }));
    rest.set('trust proxy', trustedProxyCIDRs);
    // Do not log login-ticket URLs, bodies, credentials, or SQL error objects.

    if (exposeHealth) {
        rest.get('/alive', (req, res) => res.sendStatus(200));
        rest.get('/ready', async (req, res) => res.sendStatus(await isReady() ? 200 : 500));
    }

    rest.get('/bnetserver/login/:loginTicket', (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json({
            'type': 'LOGIN_FORM',
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

    rest.post('/bnetserver/login/:loginTicket', (req, res) => track(async () => {
        const inputs = req.body && req.body.inputs;
        if (!Array.isArray(inputs) || inputs.some(input =>
            !input || typeof input !== 'object' || typeof input.input_id !== 'string')) {
            return res.sendStatus(400);
        }
        const names = inputs.filter(input => input.input_id === 'account_name');
        const passwords = inputs.filter(input => input.input_id === 'password');
        if (names.length !== 1 || passwords.length !== 1 ||
            typeof names[0].value !== 'string' || typeof passwords[0].value !== 'string' ||
            !names[0].value || !passwords[0].value || Buffer.byteLength(passwords[0].value) > 72) {
            return res.sendStatus(400);
        }

        if (!isAccepting()) { return res.sendStatus(500); }
        const ticket = await store.getLoginTicket(req.params.loginTicket);
        if (!ticket) {
            return res.sendStatus(500);
        }
        // The frontend records the client address; the HTTPS peer may be a gateway.
        await checkIP(models, ticket.address);
        const account = await models.Account.findOne({ where: { email: names[0].value } });
        if (blocked(account) || !await compare(passwords[0].value, account.hash)) {
            return res.json({ authentication_state: 'LOGIN' });
        }
        await store.authorizeLoginTicket(req.params.loginTicket, account.id);
        return res.json({ login_ticket: ticket.ticket, authentication_state: 'DONE' });
    }));

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
        logger.error('Web authentication dependency failed');
        return res.sendStatus(500);
    });
    return rest;
};
