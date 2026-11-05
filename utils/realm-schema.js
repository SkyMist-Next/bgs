'use strict';
const { DataTypes } = require('sequelize');
async function create(queryInterface, name, { omit = [], overrides = {} } = {}) {
    const schema = require('./realm-schema-v1')(queryInterface.sequelize, DataTypes)[name];
    const attributes = Object.fromEntries(Object.entries(schema.attributes).filter(([key]) => !omit.includes(key)));
    await queryInterface.createTable(schema.tableName, { ...attributes, ...overrides }, { engine: 'InnoDB', charset: 'utf8mb4', collate: 'utf8mb4_bin' });
}
module.exports = { create };
