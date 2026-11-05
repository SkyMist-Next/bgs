'use strict';
module.exports = {
    async up(queryInterface) {
        // A trigger also protects admin and bulk SQL updates that bypass model hooks.
        await queryInterface.sequelize.query(`CREATE TRIGGER IF NOT EXISTS game_accounts_expansion_immutable
            BEFORE UPDATE ON game_accounts FOR EACH ROW
            BEGIN
                IF NOT (NEW.expansion <=> OLD.expansion) THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GameAccount expansion is immutable';
                END IF;
            END`);
    },
    async down() { throw new Error('GameAccount expansion identity cannot be rolled back implicitly'); }
};
