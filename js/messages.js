var loki = require("lokijs")
var cryptedFileAdapter = require('../node_modules/lokijs/src/loki-crypted-file-adapter.js');

var messageStore = function(secret, dbFileName) {
    cryptedFileAdapter.setSecret(secret);
    var self = this
    // implement the autoloadback referenced in loki constructor
    var databaseInitialize = function() {
        self.messages = self.db.getCollection("messages");
        if ( self.messages === null) {
            self.messages = self.db.addCollection("messages");
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
        text: "the message",
        to: recipientPublicKeyFingerprint,
        from: senderPublicKeyFingerprint,
        timestamp: new Date(),
    }
*/
messageStore.prototype.insert = function(params) {
    var result = this.messages.insert(params)
    this.db.saveDatabase()
    return result
}

messageStore.prototype.update = function(params) {
    var result = this.messages.update(params)
    this.db.saveDatabase()
    return result
}

messageStore.prototype.upsert = function(params) {
    if(this.messages.find(params).length === 0) {
        return this.insert(params)  
    }
}

messageStore.prototype.find = function(query) {
    return this.messages.chain().find(query).simplesort("timestamp").data()
}

messageStore.prototype.remove = function(object) {
    return this.messages.remove(object)
}

module.exports = messageStore