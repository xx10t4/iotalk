/*

iota1k is a privacy-minded messaging app built on the IOTA Tangle.
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

$(document).ready(function () {

    const electron = require('electron')
    const app = electron.app
    const IOTA = require('iota.lib.js');
    const Crypto = require('crypto.iota.js');
    const ccurlInterface = require('ccurl.interface.js')
    const ntru = require('ntru');
    const fs = require("fs");
    const codec = require('text-encoding');
    const path = require("path");
    const MessagesStore = require("./messages.js")
    const AccountsStore = require("./accounts.js")
    const ContactsStore = require("./contacts.js")
    const ConfigurationStore = require("./configuration.js")

    // Initialize with bogus config until the real config is loaded
    var iota = new IOTA({
        'host': '',
        'port': 1
    });

    var seed;
    var messagesStore;
    var accountsStore;
    var contactsStore;
    var configuration;

    // global state
    var currentAccount;
    var currentContact;
    var newContacts = []; // holds contacts tied to new messages not seen before 
    var newMessages = []; // holds new messages not seen before 
    var value = 0; // TODO need proper forwarding of remainder values before we can allow value to be sent
    var minWeightMagnitude = 15;
    var tangleDepth = 4;
    const MESSAGE_CHECK_FREQUENCY = 20 // seconds
    const IOTALKMESSAGE_TAG = 'IOTALKMESSAGE99999999999999'

    // status codes for account and contact public keys
    const PUBLICKEY_STATUS_OK = 'ok'
    const PUBLICKEY_STATUS_NOT_FOUND = 'not_found'
    const PUBLICKEY_STATUS_MULTIPLE_FOUND = 'multiple_found'
    const PUBLICKEY_STATUS_ERROR = 'error'
    const PUBLICKEY_STATUS_BAD_FINGERPRINT = 'bad_fingerprint'
    const PUBLICKEY_STATUS_SENDING = 'sending'

    // status codes for outgoing messages
    const MESSAGE_STATUS_SENT = 'sent'
    const MESSAGE_STATUS_NOT_FOUND = 'not_found'
    const MESSAGE_STATUS_ERROR = 'error'
    const MESSAGE_STATUS_SENDING = 'sending'

    var sendTransfers = function(transfers, depth, minWeightMagnitude, callback, callbackOptions={}) {

        // Validity check for number of arguments
        if (arguments.length < 4) {
            return callback(new Error("Invalid number of arguments"));
        }

        var ccurlPath = getCcurlPath();
        console.log("ccurlPath: "+ccurlPath)

        iota.api.prepareTransfers(seed, transfers, function (error, trytes) {
            if (error) return callback(error, callbackOptions)

            iota.api.getTransactionsToApprove(depth, function (error, toApprove) {
                if (error) return callback(error, callbackOptions)

                ccurlInterface(toApprove.trunkTransaction, toApprove.branchTransaction, minWeightMagnitude, trytes, ccurlPath, function (error, attached) {                    
                    if (error) return callback(error, callbackOptions)

                    iota.api.storeTransactions(attached, function (error, success) {
                        if (error) return callback(error, callbackOptions);
                    })
                    iota.api.broadcastTransactions(attached, function (error, success) {
                        if (error) return callback(error, callbackOptions);
                         return callback(null, Object.assign({},success, callbackOptions))
                    })
                    iota.api.getNodeInfo(function (error, results) {})
                })
            })
        })
    }

    /*
        creates a new account and sends the public key to the tangle
    */
    function createAccount(name) {
        iota.api.getNewAddress(seed, { 'checksum': true, total: 1 }, function (error, addresses) {
            if (error) {
                console.log(error);
            } else {
                if (addresses.length != 1) {
                    console.log("no addresses found!");
                    return;
                }
                var address = addresses[0];
                var newKeyPair = createKeyPair();
                var privateKey = newKeyPair.privateKey.toString();
                var publicKey = newKeyPair.publicKey.toString();
                var username = getKeyUsername({ name: name, publicKey: publicKey });
                var fingerprint = createPublicKeyFinderprint(publicKey)

                var account = {
                    privateKey: privateKey,
                    publicKey: publicKey,
                    name: name,
                    address: address,
                    fingerprint: fingerprint, 
                }
                accountsStore.insert(account);
                sendAccount(account)
            }
        })
    }

    /*
        creates a tangle transaction bundle that publishes an account public key
    */
    var sendAccount = function(account) {
        var publicKeyMessage = {
            publicKey: account.publicKey,
            fingerprint: account.fingerprint,
            name: account.name,
        }
        
        var transfer = [{
            'address': account.address,
            'value': parseInt(value),
            'message': iota.utils.toTrytes(JSON.stringify(publicKeyMessage)),
            'tag': getPublicKeyTag(publicKeyMessage.publicKey)
        }]
    
        account.status = PUBLICKEY_STATUS_SENDING
        accountsStore.update(account)
        sendTransfers(transfer, tangleDepth, minWeightMagnitude, addAccountResultsHandler, {account: account})
        showAccountsList();                
    }

    /*
        retrieves a public key by fingerprint tag from the tangle
    */ 
    var getPublicKey = function(tag, callback) {
        iota.api.findTransactions({ tags: [tag] }, function (error, result) {
        
            if (error) {
                return callback(error);
            } else if (result.length == 0) {
                return callback({status: PUBLICKEY_STATUS_NOT_FOUND});
            } else {
        
                iota.api.getTrytes(result, function (error, trytes) {
        
                    if (error) {
                        return callback(error);
                    } else {
                        var transactions = trytes.map(function (transactionTrytes) {
                            return iota.utils.transactionObject(transactionTrytes);
                        });
                        
                        var bundles = sortToBundles(transactions)
                        var publicKeys = []
                        Object.keys(bundles).forEach(function(key, idx){
                            var publicKey = getBundleMessage(bundles[key])
                            publicKey.address = bundles[key][0].address
                            if (publicKey.publicKey && publicKey.fingerprint && validatePublicKey(publicKey.publicKey, publicKey.fingerprint) && getPublicKeyTag(publicKey.publicKey) === tag) {
                                publicKeys.push(publicKey);
                            } 
                        })                        
                        return callback(null, publicKeys);
                    }
                });
            }
        });
        iota.api.getNodeInfo(function (error, results) {})
    }

    /*
        creates a new message and sends the public key to the tangle
    */
    var createMessage = function(messageText, fromAccount, toContact) {

        /* TODO address cycling
            - send to the contact's most recent message replyAddress, if there is one, instead of the contact's public key address
            - create a new address for this message's replyAddress
        */
        var toAddress = toContact.address
        var replyAddress = fromAccount.address 

        var message = {
            text: messageText,
            to: toContact.fingerprint,
            from: fromAccount.fingerprint,
            address: toAddress,
            replyAddress: replyAddress,
       }
        messagesStore.insert(message)
        sendMessage(message)
    }

    /*
        creates a tangle transaction bundle that publishes a message
    */
    var sendMessage = function(message) {

        var publicKey = getContact(message.to).publicKey
        var tangleMessage = {
            to: message.to,
            from: encrypt(message.from, publicKey),
            body: encrypt(message.text, publicKey),
            replyAddress: encrypt(message.replyAddress, publicKey)
        }
        
        var transfer = [{
            'address': message.address,
            'value': 0,
            'message': iota.utils.toTrytes(JSON.stringify(tangleMessage)),
            'tag': IOTALKMESSAGE_TAG
        }]
   
        message.status = PUBLICKEY_STATUS_SENDING
        message.timestamp = dateToTimestamp()
        messagesStore.update(message)

        sendTransfers(transfer, tangleDepth, minWeightMagnitude, sendMessageResultsHandler, {message: message})
        showMessageList();                
    }

    var getMessages = function(addresses, callback) {
        iota.api.findTransactions({ tags: [IOTALKMESSAGE_TAG], addresses: addresses}, function (error, result) {            
            if (error) {
                return callback(error);
            } else if (result.length == 0) {
                // handle empty results
                return callback("no results in findTransactions callback for tag "+ IOTALKMESSAGE_TAG);
            } else {
                iota.api.getTrytes(result, function (error, trytes) {
                    if (error) {
                        return callback(error);
                    } else {
                        var transactions = trytes.map(function (transactionTrytes) {
                            return iota.utils.transactionObject(transactionTrytes);
                        });
                        var bundles = sortToBundles(transactions)
                        var messages = []
                        Object.keys(bundles).forEach(function(bundleHash){
                            var message = getBundleMessage(bundles[bundleHash])
                            message.timestamp = bundles[bundleHash][0].timestamp
                            message.address = bundles[bundleHash][0].address 
                            messages.push(message)
                        })
                        return callback(null, messages);
                    }
                });
            }
        });
        iota.api.getNodeInfo(function (error, results) {})
    }

    /*
        Returns an array of tangle addresses for inbound messages to any of the accounts
    */
    var getInboundMessageAddresses = function() {
        var addresses = []
        var fingerprints = []
        // get addresses associated with account keys
        accountsStore.all().forEach(function(account) {
            var address = account.address
            if(addresses.indexOf(address) < 0){
                addresses.push(address)
            }
            fingerprints.push(account.fingerprint)
        })
        var messages = messagesStore.find({
            from: { '$in' : fingerprints}
        })
        messages.forEach(function(message){
            address = message.replyAddress
            if(address && (addresses.indexOf(address) < 0)){
                addresses.push(address)
            }
        })

        return addresses 
     }

    /*
        Returns an array of tangle addresses for outgoing messages currently in 'sending' state
    */
    var getSendingMessagesAddresses = function() {
        var addresses = []
        messagesStore.find({
            status: { '$in' : ['sending','error']}
        }).forEach(function(message){
            var address = message.address
            if(addresses.indexOf(address) < 0){
                addresses.push(address)
            }
        })       
        return addresses 
     }

    var sortToBundles = function(transactions) {
        bundles = {}
        for( var i = 0 ; i < transactions.length ; i++) {
            var transaction = transactions[i]
            var bundleHash = transaction.bundle
            if(!bundles[bundleHash]) {
                bundles[bundleHash] = []
            }
            bundles[bundleHash][transaction.currentIndex] = transaction

        }
        return bundles
    }

    var getBundleMessage = function(bundle) {
        var messageTrytes = ''
        bundle.forEach(function (transaction, idx) {
            messageTrytes += transaction.signatureMessageFragment;
        });
        // kluge to make sure it's an even # of chars for fromTrytes
        if (messageTrytes.length % 2 > 0) {
            messageTrytes += '9'
        }
        var decodedStr = iota.utils.fromTrytes(messageTrytes);
        var jsonStr = decodedStr.substr(0, decodedStr.lastIndexOf('}') + 1)
        try {
            return JSON.parse(jsonStr);
        } catch(error) {
            return {error: error.toString()}
        }
    }

    function getKeyUsername(publicKey) {
        return publicKey.name + '@' + getPublicKeyTag(publicKey.publicKey)
    }


    var refreshAccountKeys = function() {
        accountsStore.all().forEach(function (account, idx) {           
            getPublicKey(getPublicKeyTag(account.publicKey), function(error, publicKeys){
                setStatus(error, publicKeys, account)
                accountsStore.update(account)
                showAccountsList()
            })
        })
        if(accountsStore.all().length == 1) {
            getPublicKey(getPublicKeyTag(accountsStore.all()[0].publicKey), function(error, publicKey){
                // only called because of request bug that hangs sometimes
            })
        }
    }

    var refreshContactKeys = function() {         
        contactsStore.all().forEach(function (contact, idx) {           
            getPublicKey(getPublicKeyTag(contact.publicKey), function(error, publicKeys){
                setStatus(error, publicKeys, contact)                    
                contactsStore.update(contact)
                showContactsList() 
            })
        })
        if( contactsStore.all().length == 1) {
            getPublicKey(getPublicKeyTag(  contactsStore.all()[0].publicKey), function(error, publicKey){
                // only called because of request bug that hangs sometimes
            })
        }
    }

    /*
        updates all messages with status: sending to status: error
        TODO: find out if messages were actually sent and update status appropriately
    */
    var updateSendingMessages = function() {
        messages = messagesStore.find({
                status: 'sending'
        }).forEach(function (message) {
            message.status = MESSAGE_STATUS_ERROR
            messagesStore.update(message)
        })
    }

    /* 
        set status and statusMessage on contact or account record
    */
    var setStatus = function(error, publicKeys, user) {
        user.status = PUBLICKEY_STATUS_OK
        user.statusMessage = ''
        if(error) {
            if(error.status !== undefined){
                user.status = error.status
            } else {
                user.status = PUBLICKEY_STATUS_ERROR
                user.statusMessage = error.toString()
            }
        } else {
            if(publicKeys.length < 1) { 
                user.status = PUBLICKEY_STATUS_NOT_FOUND
            }
            if(publicKeys.length > 1) { 
                user.status = PUBLICKEY_STATUS_MULTIPLE_FOUND
            }
            if(publicKeys[0].fingerprint != user.fingerprint) { 
                user.status = PUBLICKEY_STATUS_BAD_FINGERPRINT
            }
        } 
    }

    /*
        UI handler callbacks
    */
    var addAccountResultsHandler = function(error, results) {
        if (error) {
            if(results && results.account) {
                results.account.status = PUBLICKEY_STATUS_ERROR
                console.log("addAccountResultsHandler results.account: "+JSON.stringify(results.account))
                results.message.errorMessage = error.toString()
            }
        } else {
            if(results && results.account) {
                results.account.status = PUBLICKEY_STATUS_OK
            }
        }
        accountsStore.update(results.account)
        showAccountsList()
    }

    var sendMessageResultsHandler = function(error, results) {          
        if (error) {
            console.log("sendMessageResultsHandler error: "+JSON.stringify(error))
            if(results && results.message) {
                results.message.status = 'error'
                results.message.errorMessage = error
            }
        } else {
            if(results && results.message) {
                results.message.status = 'sent'
            }
        }
        messagesStore.update(results.message)
        showMessageList()
    }

    var getInboundMessagesResultsHandler = function(error, messages) {
        if(error) {
            console.log("in handler error:  " +error)
        } else {
            var newContacts = {}
            for( var i = 0; i < messages.length; i++) {
                var message = messages[i]
                if(message.to){
                    var account = getAccount(message.to)
                    if(account) {                
                        var from = decrypt(message.from, account.privateKey).text
                        if(from !== undefined) {
                            var existingContact = getContact(from)
                            if(existingContact) {
                                if(existingContact.deleted) {
                                    continue
                                } else {
                                    if (saveNewMessage(message, account)){
                                        existingContact.newMessages += 1
                                        contactsStore.update(existingContact)
                                    }
                                }
                            } else {
                                console.log("new contact:"+JSON.stringify(from))
                                
                                newContacts[from] = newContacts[from] ? newContacts[from] : []
                                newContacts[from].push(message)                                
                            }
                        }
                    }
                }
            }
            showContactsList()
            for (var from in newContacts) {
                var tag = from.substr(0,27)
                getPublicKey(tag, function(error, publicKeys){
                    addContactResultHandler(error, publicKeys)
                    if(!error && publicKeys && publicKeys[0].fingerprint === from){
                        var messages = newContacts[from]
                        console.log("messages:"+JSON.stringify(messages))
                        var contact = getContact(from)
                        for(var i = 0; i < messages.length; i++) {
                            message = messages[i]
                            var account = getAccount(message.to)
                            if (saveNewMessage(message, account)){
                                contact.newMessages += 1
                                contactsStore.update(contact)
                            }
                        }  
                        showContactsList()
                    }
                })   
            }
        }
    }

    var saveNewMessage = function(message, account) {
        var from = decrypt(message.from, account.privateKey).text
        var text = decrypt(message.body, account.privateKey).text
        var replyAddress = decrypt(message.replyAddress, account.privateKey).text
        var newMessage = {
            to: message.to,
            timestamp: message.timestamp,
            address: message.address,
            from: from,
            text: text,
            replyAddress: replyAddress
        }
        return messagesStore.upsert(newMessage)
    }

    /*
        Handles messages that may be stuck in 'sending' or 'error' states
    */
    var getSendingMessagesResultsHandler = function(error, messages) {
        if(error) {
            console.log("in handler error:  " +error)
        } else {
            messages.forEach(function(message){
                if(message.to){
                    var contact = getContact(message.to)
                    if(contact) {
                        messagesStore.find({
                            to: message.to,
                            status: { '$in' : ['sending','error']}
                        }).forEach(function(storedMessage){
                            var encrypted_text = encrypt(storedMessage.text, contact.publicKey)
                            var encrypted_from = encrypt(storedMessage.from, contact.publicKey)
                            if(encrypted_text === message.body && encrypted_from === message.from) {
                                storedMessage.status = 'sent'
                                messagesStore.update(storedMessage)
                            }
                        })
                    } else {
                        console.log("retrieved message for unknown contact: "+JSON.stringify(message))
                    }
                }
            })
        }
    }

    var addContactResultHandler = function(error, publicKeys) {
        if(error) {
            console.log("error: "+error)
        } else {
            publicKeys.forEach(function(publicKey){
                var exists = contactsStore.find({
                    publicKey: publicKey.publicKey
                })
                if(exists.length === 0){
                    publicKey.newMessages = 0
                    contactsStore.insert(publicKey);
                } 
                showContactsList()                  
            })           
        }
    }

    var getAccount = function(tagOrFingerprint) {
        var found = accountsStore.find({
            fingerprint: { '$regex': tagOrFingerprint }
        })
        if(found.length !== 1){
            console.log("warning: found "+found.length+" accounts for "+tagOrFingerprint)
        }
        return found[0]
    }

    var getContact = function(tagOrFingerprint) {
        var found = contactsStore.find({
            fingerprint: { '$regex': tagOrFingerprint }
        })
        if(found.length !== 1){
            console.log("warning: found "+found.length+" contacts for "+tagOrFingerprint)
        }
        return found[0]
    }

    /*
    The first 27 trytes of a public key fingerprint. Intended for use as a tangle transaction tag to make searching for the tag easy.
    */
    var getPublicKeyTag = function(publicKey) {
        return createPublicKeyFinderprint(publicKey).substr(0, 27);
    }

    /*
    Creates a 81 tryte hash of a public key. Intended for use as a fingerprint of the public key
    */
    var createPublicKeyFinderprint = function(publicKey) {
        const curl = new Crypto.curl();
        const hash = new Int8Array(243); //81 trytes TODO determine if this is long enough to be a secure fingerprint
        const messageTrits = Crypto.converter.trits(iota.utils.toTrytes(publicKey.toString()));
        curl.initialize();
        curl.absorb(messageTrits, 0, messageTrits.length);
        curl.squeeze(hash, 0, hash.length);
        var fingerprint = Crypto.converter.trytes(hash).toString();
        return fingerprint;
    }

    /*
    Returns boolean about whether the given fingerprint matches the given publicKey
    */
    var validatePublicKey = function(publicKey, fingerprint) {
        return createPublicKeyFinderprint(publicKey) === fingerprint
    }


// UI functions

    var showMessenger = function() {
        $(".login_section").addClass("hidden");
        $(".messenger_section").removeClass("hidden");
        $(".waiting_section").addClass("hidden");
        setDataStores()

    }

    var showLogin = function(message = "") {
        $("#login-message").html(message);
        if (message = "") {
            $("#login-message").addClass("hidden");
        } else {
            $("#login-message").removeClass("hidden");
        }
        $(".login_section").removeClass("hidden");
        $(".messenger_section").addClass("hidden");
        $(".waiting_section").addClass("hidden");

    }

    var showAccountsList = function () {
        var accounts = accountsStore.all()
        if (accounts && accounts.length > 0) {
            if(!currentAccount) {
                // default the currentAccount to the first one in the list
                setCurrentAccount(accounts[0])
            }
            $('#accountsList').empty()
            accounts.forEach(function (account) {
                var tag = getPublicKeyTag(account.publicKey)
                var userName = getKeyUsername(account) 
                var deleteButton = '<input type="radio" name="account" id="deleteAccount' + tag + '" value="'+ userName +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
                var item
                var labelClass = account.fingerprint == currentAccount.fingerprint ? "current" : ""
                if(account.status === PUBLICKEY_STATUS_OK) {
                    item = '<input type="radio" name="fromAddress" id="fromAddress' + tag + '" value="'+ userName +'"><label id="accountLabel'+tag+'" class="'+labelClass+'" for="fromAddress'+ tag + '">' + userName + ' ' +deleteButton + '</label>'
                } else if(account.status === PUBLICKEY_STATUS_SENDING) {
                    item = '<span class="glyphicon glyphicon-refresh glyphicon-refresh-animate"></span> <span class="status">creating  account <b>'+account.name + '</b>...</span>'
                } else if(account.status === PUBLICKEY_STATUS_NOT_FOUND) {
                    item = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span class="status">account <b>'+account.name + '</b> not found. <input type="radio" name="fromAddress" id="fromAddress' + tag + '" value="'+ userName +'"><button type="button" class="retry btn btn-default btn-xs"><span class="glyphicon glyphicon-repeat" aria-hidden="true"></span> Retry</button></span>'
                } else {
                    item = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span class="status">account <b>'+account.name + '</b> has a problem: '+account.status+'</span>'
                }
                $('#accountsList').append('<li id="'+ tag +'">' + item + '</li>')
            });
        }
    }

    var showContactsList = function() {
        var contacts = contactsStore.all()
        $('#contactsList').empty()
        $('#deletedContactsList').empty();
        if(contacts && contacts.length > 0) {
            contacts.forEach(function (contact) {
                if(!contact.deleted && !contact.error) {
                    var tag = getPublicKeyTag(contact.publicKey)
                    var userName = getKeyUsername(contact)
                    var labelClass = ''
                    var icon = ''
                    if(currentContact && contact.fingerprint == currentContact.fingerprint){
                        labelClass = "current"
                        icon = '<input type="radio" name="contact" id="deleteContact' + tag + '" value="'+ userName +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
                    } else if(contact.newMessages > 0) {
                        icon = '<span class="new-messages">'+contact.newMessages+'</span>'
                    }
                    var newMessageCount = contact.newMessages 
                    $('#contactsList').append('<li id="'+ tag +'"><input type="radio" name="toAddress" id="toAddress' + tag + '" value="'+ userName +'"><label  id="contactLabel'+tag+'" class="'+labelClass+'"for="toAddress'+ tag + '">' + userName + ' ' + icon + '</label></li>')
                } else {
                    var fingerprint = contact.fingerprint
                    $('#deletedContactsList').append('<li id="'+ fingerprint +'"><input type="radio" name="toAddress" id="toAddress' + fingerprint + '" value="'+  fingerprint +'"><label  id="contactLabel'+fingerprint+'" for="toAddress'+ fingerprint + '">' + fingerprint + '</label></li>')
                }
            });
        }
    }

    var showMessageList = function() {
        if(currentAccount && currentContact) {
            var messages = messagesStore.find({
                from: { '$in' :[currentAccount.fingerprint, currentContact.fingerprint]},
                to: { '$in' :[currentAccount.fingerprint, currentContact.fingerprint]}
            })
            for(var i = 0; i < newMessages.length; i++) {
                var newMessage = newMessages[i]
                if(newMessage.from == currentContact.fingerprint){
                    messages.push(newMessage)
                }
            }
            var messagesList = $('#messagesList')
            messagesList.empty()
            messages.forEach(function (message) {
                var inbound = message.from === currentContact.fingerprint
                var from = message.from === currentAccount.fingerprint ?  currentAccount :  message.from === currentContact.fingerprint ? currentContact : null
                if(from){
                    from = getKeyUsername(from) 
                }
                var messageId = message.$loki
                var deleteButton = '<input type="radio" name="message" id="deleteMessage' + messageId + '" value="'+ messageId +'"><a class="deleteMessage"><span class="glyphicon glyphicon-trash" aria-hidden="true"></span></a>'
                var info
                if(inbound || message.status === MESSAGE_STATUS_SENT) {
                    info = '<span class="time">' + formatTimestamp(message.timestamp) + '</span>'
                } else if(message.status === MESSAGE_STATUS_SENDING) {
                    info = '<span class="glyphicon glyphicon-refresh glyphicon-refresh-animate"></span> <span>sending...</span>'
                } else if(message.status === MESSAGE_STATUS_NOT_FOUND || message.status === MESSAGE_STATUS_ERROR) {
                    info = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span class="status">message not sent. <input type="radio" name="fromAddress" id="message' + messageId + '" value="'+ messageId +'"><button type="button" class="retry btn btn-default btn-xs"><span class="glyphicon glyphicon-repeat" aria-hidden="true"></span> Resend</button> </span> ' + deleteButton
                } else {
                    info = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span>error sending message.</span> ' + deleteButton
                }
                
                var scrollId = 'scrollTo' + messageId

                messagesList.append('<li class="message" id="'+ scrollId +'"><b>' + from + '</b> '+info+ '<br />'+message.text+'</li>')

                $('#messageScroll').animate({scrollTop: $('#messageScroll').prop("scrollHeight")}, 500);
            });
        }
    }

    var showAlert = function(type, message) {
        var newAlert = '<div class="alert alert-'+type+' alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button>'+ message+'</div>';
       // var html = $("#alerts").html() + newAlert
        $("#alertsHolder").html(newAlert);
    }

    var hideAlerts = function() {
        $("#alertsHolder").html('');
    } 

    var validateSeed = function(value) {
        var result = { "valid": true, "message": "" }
        if (!value || value == "") {
            result["message"] = "Seed cannot be blank"
        }
        if (result["message"] != "") {
            result["valid"] = false;
        }
        return result;
    }

    //
    // Properly formats the seed, replacing all non-latin chars with 9's
    //
    var setSeed = function(value) {
        seed = "";
        value = value.toUpperCase();
        for (var i = 0; i < value.length; i++) {
            if (("9ABCDEFGHIJKLMNOPQRSTUVWXYZ").indexOf(value.charAt(i)) < 0) {
                seed += "9";
            } else {
                seed += value.charAt(i);
            }
        }
    }

    var setDataStores = function() {
        iota.api.getNewAddress(seed, { 'checksum': true, total: 1, index: 0 }, function (error, addresses) {
            if (error) {
                console.log(error);
            } else {
                if (addresses.length != 1) {
                    console.log("no addresses found!");
                    return;
                }
                var address = addresses[0];
                configuration = new ConfigurationStore(seed, createDatastoreFilename('config', address), function(){
                    initConfiguration()
                    messagesStore = new MessagesStore(seed, createDatastoreFilename('messages', address), function(){
                        accountsStore = new AccountsStore(seed, createDatastoreFilename('accounts', address), function(){
                            contactsStore = new ContactsStore(seed, createDatastoreFilename('contacts', address), afterDataStoresInitialized)
                        })                
                    })
                })              
            }
        })       
    }
    
    /*
        callback to do stuff after all dataStores have been intialized
    */
    var afterDataStoresInitialized = function() {
        updateSendingMessages()
        refreshAccountKeys()
        showAccountsList()
        showContactsList()
        checkForNewMessages()
    }

    var initConfiguration = function() {
        var node_address = configuration.get('node_address').value
        var node_port = configuration.get('node_port').value
        $('#config_node_address').val(node_address)
        $('#config_node_port').val(node_port)
        if(!validNodeAddress(node_address, node_port)) {
            showAlert('warning', 'A valid node address is required. Set node address by clicking the <span class="glyphicon glyphicon-cog" rel="tooltip" title="Configuration"></span> icon above.</a>')
        } else {
            iota = new IOTA({
                'host': node_address,
                'port': node_port
            });
            iota.api.getNodeInfo(function (error, results) {
                if(error || !results) {
                    showAlert('warning', node_address + ' returned an error. Set node address by clicking the <span class="glyphicon glyphicon-cog" rel="tooltip" title="Configuration"></span> icon above.')    
                } else if(results.latestMilestoneIndex !== results.latestSolidSubtangleMilestoneIndex) {
                    showAlert('warning', node_address + ' is not fully synced. You may not be able to send messages.')    
                } else {
                    showAlert('success', 'Node configuration is complete.')    
                }
            })
        }
    }

    var validNodeAddress = function(address, port) {
        if(!(address && port)) {
            return false
        }
        return address.match(/^https?:\/\/.+/) && port.match(/\d+/)
    }

    var createDatastoreFilename = function(type, address) {
        return path.join(electron.remote.app.getPath('userData'), address + '.' + type + '.data');
    }

    var getCcurlPath = function() {
        var is64BitOS = process.arch == "x64";
        if (process.platform == "win32") {
            return path.join(electron.remote.app.getAppPath(), "lib", "ccurl", "win" + (is64BitOS ? "64" : "32"));
        } else if (process.platform == "darwin") {
            return path.join(electron.remote.app.getAppPath(), "lib", "ccurl", "mac");
        } else {
            return path.join(electron.remote.app.getAppPath(), "lib", "ccurl", "lin" + (is64BitOS ? "64" : "32"));
        }
    }

    var checkForNewMessages = function () {
        getMessages(getInboundMessageAddresses(),getInboundMessagesResultsHandler)
        setTimeout(checkForNewMessages, MESSAGE_CHECK_FREQUENCY*1000)
    }

    // UI Event handlers

    $("#login").on("click", function () {
        var seed_ = $("#userSeed").val();
        var check = validateSeed(seed_);
        if (!check["valid"]) {
            showLogin(check["message"]);
            return;
        }
        $("#login-message").addClass("hidden");
        // We modify the entered seed to fit the criteria of 81 chars, all uppercase and only latin letters
        setSeed(seed_);
        showMessenger();
    });

    $("#logoutBtn").on("click", function () {
        setSeed('');
        showLogin();
    });

    $("#add_contact").on("click", function () {
        var address = $("#contact_address").val();
        var tag = address.split('@')[1];
        $("#contact_address").val('');
        // the http request hangs unless this method is called more than once, so workaround is to just call it twice. WTF!!
        getPublicKey(tag, addContactResultHandler);
    });

    $("#create_account").on("click", function () {
        var name = $("#name").val();
        $("#name").val('');
        createAccount(name)
    })

    $("#save_config").on("click", function () {
        [
            'node_address',
            'node_port'
        ].forEach(function(key, idx, keys){
            var config = configuration.get(key)            
            config.value = $("#config_"+key).val()
            configuration.set(config)
            if(idx === (keys.length - 1)){
                // after last config is saved, redo initialization
                initConfiguration()
            }
        }) 
    })

    $('#contactsList').on('click','label',function() {
        var username = $(this).prev().val()
        setCurrentContact(getContact(username.split('@')[1]))
    });

    $('#contactsList').on('click','a.delete',function(event) {
        var username = $(this).prev().val()
        var contact = getContact(username.split('@')[1])       
        var messages = messagesStore.find({
            '$or': [
                {from: { '$in' :[contact.fingerprint]}},
                {to: { '$in' :[contact.fingerprint]}}
            ]
        })
        var confirmMessage = "Are you sure you want to delete contact "+ username + "?"
        if(messages.length > 0) {
            confirmMessage += "\n\nThis will delete "+messages.length+" messages between you and this contact."
        }
        if(confirm(confirmMessage)){
            messagesStore.remove(messages)
            contactsStore.softRemove(contact)
        }
        showContactsList()
    });

    $('#accountsList').on('click','label',function() {
        var username = $(this).prev().val()
        setCurrentAccount(getAccount(username.split('@')[1]))
    });

    $('#accountsList').on('click','a.delete',function(event) {
        var username = $(this).prev().val()
        var contact = getAccount(username.split('@')[1])       
        var messages = messagesStore.find({
            '$or': [
                {from: { '$in' :[contact.fingerprint]}},
                {to: { '$in' :[contact.fingerprint]}}
            ]
        })
        var confirmMessage = "Are you sure you want to delete account "+ username + "?"
        if(messages.length > 0) {
            confirmMessage += "\n\nThis will delete "+messages.length+" messages to and from this account."
        }
        if(confirm(confirmMessage)){
            messagesStore.remove(messages)
            accountsStore.remove(contact)
        }
        showAccountsList()
    });

    $('#accountsList').on('click','button.retry',function() {
        var username = $(this).prev().val()
        currentAccount = getAccount(username.split('@')[1])
        sendAccount(currentAccount)
        showMessageList();
    });
    
    $("#send_message").on("click", function () {
        var message = $("#message").val();
        $("#message").val('');
        if(message.match(/^\s*$/)) {
            showAlert('warning',"Message is blank!")
        } else if(!(currentAccount && currentContact)) {
            showAlert('warning',"Select an <b>Account</b> to send from and a <b>Contact</b> to send to.")            
        } else {
            createMessage(message, currentAccount, currentContact)
        }        
    })

    $('#messagesList').on('click','button.retry',function() {
        var messageId = $(this).prev().val()
        var results = messagesStore.find({$loki: parseInt(messageId)})
        // TODO check and handle cases where results.length != 1
        sendMessage(results[0])
    });
    
    $('#messagesList').on('click','a.deleteMessage',function() {
        var messageId = $(this).prev().val()
        messagesStore.remove(messagesStore.find({$loki: parseInt(messageId)}))
        showMessageList()
    }); 
    
    
    // Set globals
    var setCurrentAccount = function(account) {
        currentAccount = account
        if(currentAccount){
            var tag = getPublicKeyTag(currentAccount.publicKey)
            $('#accountsList label').removeClass("current")   
            $('#accountLabel'+tag).addClass("current")
        }
        showMessageList()        
    }

    var setCurrentContact = function(contact) {
        currentContact = contact
        if(currentContact){
            currentContact.newMessages = 0
            contactsStore.update(currentContact)
            var tag = getPublicKeyTag(currentContact.publicKey)
            $('#contactsList label').removeClass("current")   
            $('#newContactsList label').removeClass("current")
            $('#contactLabel'+tag).addClass("current")
        }
        showContactsList()
        showMessageList()        
    }

    // Utilities
    /*
        Returns a UNIX timestamp - number of seconds since the epoch
    */
    var dateToTimestamp = function(date = null) {
        if(date === null) {
            date = new Date()
        }
        return Math.floor(date.getTime()/1000)
    }

    /*
        Convert UNIX timestamp to a Date
    */
    var timestampToDate = function(timestamp) {
        return new Date(timestamp*1000)
    }

    /*
        Returns a locale-based string representin a time or date and time
    */
    var formatTimestamp = function(timestamp) {
        if(timestamp !== undefined) {
            var date = timestampToDate(timestamp)
            if((new Date().getTime() - date.getTime()) > 1000*3600*12){ 
                // if more tha 12 hours ago, include date in display
                return date.toLocaleString().toLowerCase()
            } else {
                // otherwise just display the time
                return date.toLocaleTimeString().toLowerCase()
            }           
        }
        return ''
    }

    /*
        ntru functions
    */
    var createKeyPair = function() {
        return ntru.keyPair();
    }

    var encrypt = function(message, publicKey) {
        var encodedMessage = new codec.TextEncoder().encode(message);
        publicKey = new Uint8Array(publicKey.split(','))
        encryptedArray = ntru.encrypt(encodedMessage, publicKey);
        var encoded = ''
        encryptedArray.forEach(function(num){
            encoded += String.fromCharCode(num)
        })
        return Buffer.from(encoded).toString('base64')
    }

    var decrypt = function(cipherText, privateKey) {
        var cipherTextUtf8 =  Buffer.from(cipherText, 'base64').toString('utf-8')
        var decoded = []
        cipherTextUtf8.split('').forEach(function(char){
            decoded.push(char.charCodeAt(0))
        })
        var encodedCipher = new Uint8Array(decoded)
        privateKey = new Uint8Array(privateKey.split(','))
        try{
            var encodedMessage = ntru.decrypt(encodedCipher, privateKey);
            return {text: new codec.TextDecoder().decode(encodedMessage)};
        } catch(error) {
            return {error: error.toString()}
        }
    }

});
