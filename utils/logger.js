'use strict';

const winston = require('winston');

module.exports = function createLogger(fileConfig, environment = process.env.NODE_ENV) {
    const { json = true, colorize = false, timestamp = true, ...fileOptions } = fileConfig;
    const formats = [winston.format.errors({ stack: true }), winston.format.splat()];
    if (timestamp) {
        formats.push(winston.format.timestamp());
    }
    if (colorize && !json) {
        formats.push(winston.format.colorize());
    }
    formats.push(json ? winston.format.json() : winston.format.printf(info =>
        `${info.timestamp ? info.timestamp + ' ' : ''}${info.level}: ${info.stack || info.message}`));
    const transports = [new winston.transports.File({
        ...fileOptions,
        format: winston.format.combine(...formats)
    })];
    if (environment === 'development') {
        transports.push(new winston.transports.Console({
            level: 'debug',
            handleExceptions: true,
            format: winston.format.combine(
                winston.format.errors({ stack: true }),
                winston.format.colorize(),
                winston.format.printf(info => `${info.level}: ${info.stack || info.message}`)
            )
        }));
    }
    return winston.createLogger({
        // Normalize non-enumerable Error fields before transports clone each record.
        format: winston.format.combine(winston.format.errors({ stack: true }), winston.format.splat()),
        transports,
        exitOnError: false
    });
};
