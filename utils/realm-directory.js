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
}
module.exports = RealmDirectory;
