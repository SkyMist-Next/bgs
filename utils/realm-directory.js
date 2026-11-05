'use strict';
class RealmDirectory {
    constructor(models, database = 'skymist_operator') {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(database)) { throw new Error('Invalid realm database'); }
        this.sql = models.sequelize;
        this.table = '`' + database + '`.`realmlist`';
    }
    async rows() {
        // The operator owns this cross-database catalog. Sequelize v6's MySQL
        // schema mapping quotes schema.table as one identifier, so retain this
        // read-only query with a validated database name and fixed SQL.
        return this.sql.query('SELECT *, (online AND available_until > UTC_TIMESTAMP(6)) AS available FROM ' + this.table + ' ORDER BY region, battlegroup, realm_id LIMIT 4097', { type: 'SELECT' }).then(rows => {
            if (rows.length > 4096) { throw new Error('Realm directory limit exceeded'); }
            return rows;
        });
    }
    async listMetadataJSON(prefix) {
        const entries = {};
        for (const row of await this.rows()) {
            const sub = row.region + '-' + row.battlegroup + '-0';
            const address = row.region + '-' + row.battlegroup + '-' + row.realm_id;
            const key = '/aurora/services/WoWService/subRegions/' + sub + '/virtualRealms/' + address;
            if (!key.startsWith(prefix)) { continue; }
            entries[key] = { realmUID: row.realm_uid, namespace: row.namespace, gameServerId: address, available: Boolean(row.available), securityLevel: row.security_level,
                region: row.region, expansion: row.expansion, build: row.build, isHidden: !row.available, deleting: false,
                endpoints: typeof row.endpoints === 'string' ? JSON.parse(row.endpoints) : row.endpoints,
                update: { name: row.name, cfgTimezonesID: 1, cfgCategoriesID: row.timezone, cfgRealmsID: row.realm_id,
                    cfgConfigsID: row.game_type + 1, cfgLanguagesID: 1, populationState: row.available ? Math.max(row.population, 1) : 0,
                    version: { versionMajor: row.version_major, versionMinor: row.version_minor, versionRevision: row.version_revision, versionBuild: row.build } } };
        }
        return entries;
    }
    async getMetadataJSON(key) {
        const realmKey = key.replace('/gameServers/', '/virtualRealms/');
        const rows = await this.listMetadataJSON(realmKey);
        if (!rows[realmKey]) { throw new Error('Realm unavailable'); }
        return rows[realmKey];
    }
    listMetadata(prefix) { return this.listMetadataJSON(prefix); }
}
module.exports = RealmDirectory;
