var loki = require("lokijs")
var cryptedFileAdapter = require('../node_modules/lokijs/src/loki-crypted-file-adapter.js');

var contactsStore = function(secret, dbFileName, callback = null) {
    cryptedFileAdapter.setSecret(secret);
    var self = this
    // implement the autoloadback referenced in loki constructor
    var databaseInitialize = function() {
        self.contacts = self.db.getCollection("contacts");
        if ( self.contacts === null) {
            self.contacts = self.db.addCollection("contacts");
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
contactsStore.prototype.insert = function(params) {
    var result = this.contacts.insert(params)
    this.db.saveDatabase()
    return result
}

contactsStore.prototype.update = function(params) {
    var result = this.contacts.update(params)
    this.db.saveDatabase()
    return result
}

contactsStore.prototype.find = function(query) {
    return this.contacts.find(query)
}

contactsStore.prototype.all = function() {
    return this.contacts.find({})
}

contactsStore.prototype.remove = function(object) {
    return this.contacts.remove(object)
}

module.exports = contactsStore