/*

iotalk is a privacy-minded messaging app built on the IOTA Tangle.
Copyright (C) 2017  xx10t4 <xx10t4@gmail.com>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.

*/

var loki = require("lokijs")
var cryptedFileAdapter = require('../../node_modules/lokijs/src/loki-crypted-file-adapter.js');

var messageStore = function(secret, dbFileName, callback = null) {
    cryptedFileAdapter.setSecret(secret);
    var self = this
    // implement the autoloadback referenced in loki constructor
    var databaseInitialize = function() {
        self.messages = self.db.getCollection("messages");
        if ( self.messages === null) {
            self.messages = self.db.addCollection("messages");
        }
        if(callback) {
            callback()
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
    return null
}

messageStore.prototype.find = function(query) {
    return this.messages.chain().find(query).simplesort("timestamp").data()
}

messageStore.prototype.remove = function(object) {
    return this.messages.remove(object)
}

module.exports = messageStore