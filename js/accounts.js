var loki = require("lokijs")
var cryptedFileAdapter = require('../node_modules/lokijs/src/loki-crypted-file-adapter.js');

var accountsStore = function(secret, dbFileName, callback = null) {
    cryptedFileAdapter.setSecret(secret);
    var self = this
    // implement the autoloadback referenced in loki constructor
    var databaseInitialize = function() {
        self.accounts = self.db.getCollection("accounts");
        if ( self.accounts === null) {
            self.accounts = self.db.addCollection("accounts");
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
        privateKey: "1,3,0,6,16,30,...",  // ntru private key
        publicKey: "1,3,0,6,16,30,...",  // ntru public key
        name: "myHandle", 
        fingerprint: "ABCD...", // 81 Trytes string generated from publicKey hash
        address: "ABCD...", // Tangle address where public key is stored
    }
*/
accountsStore.prototype.insert = function(params) {
    var result = this.accounts.insert(params)
    this.db.saveDatabase()
    return result
}

accountsStore.prototype.update = function(params) {
    var result = this.accounts.update(params)
    this.db.saveDatabase()
    return result
}

accountsStore.prototype.find = function(query) {
    return this.accounts.find(query)
}

accountsStore.prototype.all = function() {
    return this.accounts.find({})
}

accountsStore.prototype.remove = function(object) {
    return this.accounts.remove(object)
}

module.exports = accountsStore