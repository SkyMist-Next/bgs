/**
 * Created by kaloyan on 14.9.2016 г..
 */
const zlib = require('zlib');
const Realm = require('../../models/realm.js');

module.exports = {
    serialize:  function(name, object){
        return name + ":" + JSON.stringify(object);
    },

    compress: function (input) {
        const lenght = input.length + 1;
        const buffer = Buffer.alloc(lenght + 4);
        buffer.writeUInt32BE(lenght, 0);
        buffer.append(zlib.deflateSync(input, {}));
        return buffer.toString();
    },

    getSubregions: function (region) {

        
    },

    getRealms: function (region, subregion) {
        var realmsJson = {};
        realmsJson.updates = [];
        global.redisConnection.smembers(`${region}-${subregion}-0`, function (err,realms) {
            realms.forEach(function (realm) {
                const handle = new Realm.Handle(region, subregion, parseInt(realm, 10));
                var state = {};
                state.deleting = false;
                global.redisConnection.get(handle.GetAddressString(), function(err, realmUpdate){
                    realmUpdate.wowrealmaddress = handler.GetAddress();
                    state.update = realmUpdate;
                    realmsJson.updates.push(state);
                });
            });
        });
        
    }
};