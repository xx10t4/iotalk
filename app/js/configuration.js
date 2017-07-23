var loki = require("lokijs")
var cryptedFileAdapter = require('../../node_modules/lokijs/src/loki-crypted-file-adapter.js');

var configurationStore = function(secret, dbFileName, callback = null) {
    cryptedFileAdapter.setSecret(secret);
    var self = this
    // implement the autoloadback referenced in loki constructor
    var databaseInitialize = function() {
        self.config = self.db.getCollection("configuration");
        if ( self.config === null) {
            self.config = self.db.addCollection("configuration");
        }
        if(callback) {
            callback(self)
        }
    }
 
    this.db = new loki(dbFileName, {
        adapter: cryptedFileAdapter,
        autoload: true,
	    autoloadCallback : databaseInitialize,
	    autosave: true, 
	    autosaveInterval: 4000 
    });
}

/*
    params = {
        publicKey: "1,3,0,6,16,30,...",  // ntru public key
        name: "myHandle", 
        fingerprint: "ABCD...", // 81 Trytes string generated from publicKey hash
        address: "ABCD...", // Tangle address where public key is stored
    }
*/
configurationStore.prototype.set = function(config) {
    var result = this.config.update(config)
    this.db.saveDatabase()
    return result
}

configurationStore.prototype.get = function(key) {
    var query = {key: key}
    var result = this.config.find(query)
    if(result.length === 0) {
        result = [this.config.insert(query)] 
    }
    return result[0]
}

configurationStore.prototype.all = function() {
    return this.config.find({})
}

configurationStore.prototype.remove = function(object) {
    return this.config.remove(object)
}

module.exports = configurationStore