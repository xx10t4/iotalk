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
    var Mam = require("./mam.node.js")
    var IOTA = require('iota.lib.js');

    const Crypto = require('iota.crypto.js');
    const ccurlInterface = require('ccurl.interface.js')
    const ntru = require('ntru');
    const fs = require("fs");
    const codec = require('text-encoding');
    const path = require("path");
    const toastr = require("toastr")
    const winston = require("winston")
    const MessagesStore = require("./messages.js")
    const AccountsStore = require("./accounts.js")
    const ContactsStore = require("./contacts.js")
    const ConfigurationStore = require("./configuration.js")


    const LOG_LEVEL = 'debug' // valid values: 'debug', 'warning', 'error'

    winston.cli()
    var logger = new (winston.Logger)({
        transports: [
          new (winston.transports.Console)(),
          new (winston.transports.File)({ filename: path.join(electron.remote.app.getPath('userData'), 'logger.log') })
        ]
    });

    // Initialize with bogus config until the real config is loaded
    var iota = new IOTA({
        'provider': ''
    });

    var seed;
    // Local data storage collections
    var messagesStore;
    var accountsStore;
    var contactsStore;
    var configuration;

    /*----------- global state vars ---------------- */
    var currentAccount;
    var currentContact;
    var seenTransactions = []

    // queue for sending transactions to the tangle
    var sendingQueue = [];
    var ccurlAvailable = true;
    /*----------- end global state vars ---------------- */

    var value = 0;
    var minWeightMagnitude = 14;
    var tangleDepth = 4;
    const MESSAGE_CHECK_FREQUENCY = 15 // seconds
    const DATA_STORE_VERSION = 1

    // status codes for account and contact public keys (user.keyStatus)
    const PUBLICKEY_STATUS_OK = 'ok'
    const PUBLICKEY_STATUS_NOT_FOUND = 'not_found'
    const PUBLICKEY_STATUS_MULTIPLE_FOUND = 'multiple_found'
    const PUBLICKEY_STATUS_ERROR = 'error'
    const PUBLICKEY_STATUS_BAD_ADDRESS = 'bad_address'
    const PUBLICKEY_STATUS_SENDING = 'sending'

    const MAM_ROOT_STATUS_SENDING = 'sending'
    const MAM_ROOT_STATUS_SENT = 'sent'
    const MAM_ROOT_STATUS_BLOCKED = 'blocked'
    const MAM_ROOT_STATUS_ERROR = 'error'

    // status codes for outgoing messages (message.status)
    const MESSAGE_STATUS_SENT = 'sent'
    const MESSAGE_STATUS_NOT_FOUND = 'not_found'
    const MESSAGE_STATUS_ERROR = 'error'
    const MESSAGE_STATUS_SENDING = 'sending'
    const MESSAGE_STATUS_QUEUEING = 'queueing'
    const MESSAGE_STATUS_POWING = 'powing'

    const MAM_ROOT_TAG = 'MAM9ROOT9999999999999999999'

    /*
        creates a new account and sends the public key to the tangle
    */
    function createAccount(name) {
        iota.api.getNewAddress(seed, { 'checksum': true, total: 1 }, function (error, addresses) {
            if (error) {
                logger.log('error', "createAccount error: "+error);
            } else {
                if (addresses.length != 1) {
                    logger.log('error', "createAccount no addresses found!");
                    return;
                }
                var address = addresses[0];
                var newKeyPair = createKeyPair();
                var privateKey = newKeyPair.privateKey.toString();
                var publicKey = newKeyPair.publicKey.toString();
                var address = createFingerprint(publicKey)

                var account = {
                    privateKey: privateKey,
                    publicKey: publicKey,
                    name: name,
                    address: address
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
            name: account.name,
        }

        var transfer = [{
            'address': account.address,
            'value': parseInt(value),
            'message': iota.utils.toTrytes(JSON.stringify(publicKeyMessage)),
            'tag': account.address.substr(0,27)
        }]

        account.keyStatus = PUBLICKEY_STATUS_SENDING
        accountsStore.update(account)
        sendTransfers(transfer, addAccountResultsHandler, {account: account})
        showAccountsList();
    }

    var initializeContact = function(fromAccount, username) {

        tag = getTagFromUsername(username)
        let newContact = {
            username: username,
            account: fromAccount.address,
            mamRootStatus: MAM_ROOT_STATUS_SENDING
        }
        contactsStore.insert(newContact)

        getPublicKey(tag, function(error, publicKeys){
            if(error) {
                logger.log('error', "initializeContact error: "+error)
            } else {
                let contact = null;
                publicKeys.forEach(function(publicKey){
                    var exists = contactsStore.find({
                        username: username,
                        account: fromAccount.address
                    })
                    if(exists.length > 0){
                        let contact = exists[0]
                        contact.newMessages = 0
                        contact.publicKey = publicKey.publicKey
                        contact.name = publicKey.name
                        contact.address = publicKey.address
                        contact.bundle = publicKey.bundle
                        contact.mamRootStatus = null
                        contactsStore.update(contact);
                        for(var i = 1 ; i < exists.length ; i++) {
                            contactsStore.remove(exists[i])
                        }
                    }
                    showContactsList()
                })
            }
        })
        showContactsList()
    }

    /*
        retrieves a public key by tag or address from the tangle
    */
    var getPublicKey = function(tagOrAddress, callback) {
        let searchCriteria = {}
        if(tagOrAddress.length == 27){
            searchCriteria['tags'] = [tagOrAddress]
        } else if(tagOrAddress.length == 81) {
            searchCriteria['addresses'] = [tagOrAddress]
        } else {
            return callback("tagOrAddress must be 27 or 81 chars")
        }
        iota.api.findTransactions(searchCriteria, function (error, result) {
            if (error) {
                return callback(error);
            } else if (result.length == 0) {
                return callback({status: PUBLICKEY_STATUS_NOT_FOUND});
            } else {

                iota.api.getTrytes(result, function (error, trytes) {

                    if (error) {
                        return callback(error);
                    } else {
                        var publicKeys = []
                        var seenAddresses = []
                        messagesFromBundles(trytes).forEach(function(message){
                            if (message.publicKey && validatePublicKey(message.publicKey, message.address, tagOrAddress) && seenAddresses.indexOf(message.address) < 0) {
                                publicKeys.push(message);
                                seenAddresses.push(message.address)
                                }
                        })
                        return callback(null, publicKeys);
                    }
                });
            }
        });
        iota.api.getNodeInfo(function (error, results) {})
    }

    var sendContactRequest = function(toContact) {
        let mamState = getActiveMamState(toContact)
        var fromMamRoot = mamState.channel.next_root
        var tangleMessage = createMKEPMessage(toContact, fromMamRoot)

        toContact.mamRootStatus = MAM_ROOT_STATUS_SENDING
        contactsStore.update(toContact)
        showContactsList();
        sendTransfers([tangleMessage], sendContactRequestResultsHandler, {contact: toContact})
    }

    /*
        creates a new MKEP message
    */
    var createMKEPMessage = function(contact, fromMamRoot, toMamRoot = null) {
        var msg = {
            fromAddress: encrypt(contact.account, contact.publicKey),
            fromKey: encrypt(fromMamRoot, contact.publicKey)
        }
        if(toMamRoot) {
            msg.toKey = encrypt(toMamRoot, contact.publicKey)
        }
        return {
            address: contact.address,
            value: 0,
            message: iota.utils.toTrytes(JSON.stringify(msg)),
            tag: MAM_ROOT_TAG
        }
    }

    /*
        creates a new MAM message
    */
    var createMessage = function(messageText, toContact) {
        let message = {
            timestamp: dateToTimestamp(),
            text: messageText,

        }
        if(toContact.mamRootStatus !== MAM_ROOT_STATUS_SENT) {
            sendContactRequest(toContact)
            message.inboundMamRoots = Object.keys(getActiveInboundMamRoots(toContact))
        }
        let mamState  = getActiveMamState(toContact)
        let mamMessage = Mam.create(mamState, iota.utils.toTrytes(JSON.stringify(message)))
        let localMessage = {
            text: message.text,
            timestamp: message.timestamp,
            to: toContact.address,
            from: toContact.account,
            mamRoot: mamMessage.root,
            status: MESSAGE_STATUS_SENDING
       }
       localMessage = messagesStore.insert(localMessage)
       sendMessage(mamMessage, localMessage)
    }

    var getActiveMamState = function(contact) {
        let mamState = null
        if(contact.mamData && contact.mamData.outBound && contact.mamData.outBound.activeMamState) {
            mamState = contact.mamData.outBound.activeMamState
        } else {
            mamState = initializeActiveMamState(contact)
        }
        return copyObject(mamState)
    }

    var initializeActiveMamState = function(contact) {
        let mamState = null
        if(contact.mamData.outBound.mamStates.length > 0) {
            mamState = contact.mamData.outBound.mamStates[contact.mamData.outBound.mamStates.length - 1]
        } else {
            mamState = Mam.changeMode(Mam.init(iota), 'private')
            mamState = copyObject(Mam.create(mamState, 'Initial Message').state)
            contact.mamData.outBound.mamStates = [mamState]
            contactsStore.update(contact)
        }
        setActiveMamState(contact, mamState)
        return mamState
    }

    var setActiveMamState = function(contact, mamState) {
        if(mamState) {
            contact.mamData.outBound.activeMamState = copyObject(mamState)
            contactsStore.update(contact)
        }
    }

    /*
        creates a tangle transaction bundle that publishes a message
    */
    var sendMessage = function(mamMessage, localMessage) {

        var transfer = [{
            'address': mamMessage.address,
            'value': 0,
            'message': mamMessage.payload
        }]

        localMessage.status = MESSAGE_STATUS_SENDING
        messagesStore.update(localMessage)

        sendTransfers(transfer, sendMessageResultsHandler, {message: localMessage})
        showMessageList();
    }

    var resendMessage = function(message) {
        if(message){
            var text = message.text
            var contact = getContact(message.to, message.from)
            messagesStore.remove(message)
            createMessage(text, contact)
        }
    }

    var getMessages = function() {

        contactsStore.find({}).forEach(function(contact){
            if(contact.deleted || contact.blocked) {
                return
            }
            if(contact.mamRootStatus !== MAM_ROOT_STATUS_BLOCKED) {
                let mamRoots = getActiveInboundMamRoots(contact)
                Object.keys(mamRoots).forEach(function(parentMamRoot) {
                    let mamRoot = parentMamRoot
                    if(mamRoots[parentMamRoot] && mamRoots[parentMamRoot].length > 0) {
                        // TODO try use the most recent active root to avoid re-fetching all messages every time
                        // mamRoot = mamRoots[parentMamRoot]
                    }
                    if(isValidAddress(mamRoot)) {
                        getMessageFromMamRoot(mamRoot, parentMamRoot, contact, messageFromMamRootHandler)
                    }
                })
            }
        })
        showMessageList()
    }

    var getMessageFromMamRoot = function(mamRoot, parentMamRoot, contact, callback = null) {
        let address = createFingerprint(mamRoot, false)
        iota.api.findTransactions({addresses: [address]}, function (error, result) {
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
                        var messages = []
                        Object.keys(bundles).forEach(function(key, idx){
                            var bundle = bundles[key]
                            var message = getBundleMessage(bundle)
                            if(message){
                                let decoded = Mam.decode(message, '', mamRoot)
                                messages.push(decoded)
                            }
                        })
                        return callback(null, {messages: messages, contact: contact, parentMamRoot: parentMamRoot});
                    }
                });
            }
        })
    }

    var messageFromMamRootHandler = function(error, result) {
        if(result) {
            let parentMamRoot = result.parentMamRoot
            let contact = result.contact
            result.messages.forEach(function(mamMessage){
                let message = iota.utils.fromTrytes(mamMessage.payload)
                let nextRoot = mamMessage.next_root

                let text = null
                let timestamp = null
                let inboundMamRoots = []
                try {
                    let messageObj = JSON.parse(message)
                    text = messageObj.text
                    timestamp = messageObj.timestamp
                    inboundMamRoots = messageObj.inboundMamRoots
                } catch (e) {
                    return
                }
                if(inboundMamRoots && inboundMamRoots.length > 0) {
                    updateContactFromMamMessage(contact,inboundMamRoots)
                }
                if(isValidAddress(nextRoot)) {
                    getMessageFromMamRoot(nextRoot, parentMamRoot, contact, messageFromMamRootHandler)
                }
                if(!(text && timestamp)) {
                    // ignore message if it is missing text and timestamp
                    return
                }
                let existing = messagesStore.find({
                    text: text,
                    timestamp: timestamp,
                    from: contact.address,
                    to: contact.account,
                })
                if(existing.length === 0) {
                    messagesStore.insert({
                        text: text,
                        timestamp: timestamp,
                        from: contact.address,
                        to: contact.account,
                        parentMamRoot: parentMamRoot
                    })
                    contact.newMessages += 1
                    updateActiveInboundMamRoots(contact, parentMamRoot, nextRoot)
                    showContactsList()
                    showMessageList()
                }
            })
        }
    }

    var updateActiveInboundMamRoots = function(contact, parentRoot, currentRoot = null) {
        let activeMamRoots = copyObject(getActiveInboundMamRoots(contact))
        if(!activeMamRoots[parentRoot]) {
            activeMamRoots[parentRoot] = null
        }
        if(currentRoot) {
            activeMamRoots[parentRoot] = currentRoot
        }
        contact.activeMamRoots = activeMamRoots
        contactsStore.update(contact)
    }

    var updateContactFromMamMessage = function(contact, message) {

        let inboundMamRoots = message.inboundMamRoots || []
        inboundMamRoots.forEach(function(mamRootFromContact){

        })
    }

    var getActiveInboundMamRoots = function(contact) {
        return contact.activeMamRoots || {}
    }

    var getContactRequests = function() {
        let accounts = accountsStore.all()
        let addresses = accounts.map(function(account){ return account.address})
        iota.api.findTransactions({ addresses: addresses, tags: [MAM_ROOT_TAG]}, function (error, results) {
            if (error) {
                logger.log('error',"Error in getContactRequests",error)
            } else if (results.length == 0) {
                // handle empty results
                logger.log('warning',"no results in getContactRequests callback for addresses",addresses)
            } else {

                // TODO store seenTransactions for persistence across login sessions
                let newTransactions = []
                results.forEach(function(transactionHash){
                    if(seenTransactions.indexOf(transactionHash) < 0){
                        newTransactions.push(transactionHash)
                        seenTransactions.push(transactionHash)
                    }
                })
                iota.api.getTrytes(newTransactions, function (error, trytes) {
                    if (error) {
                        logger.log('error', error);
                    } else {
                        let messages = messagesFromBundles(trytes);
                        let groupedMessages = {}
                        for( var i = 0; i < messages.length; i++) {
                            let message = messages[i]
                            let account = accounts.find((acc) => { return acc.address === message.address})
                            if(!account) {
                                logger.log('error', "No account exists for contact request to address "+ message.address)
                                continue
                            }
                            groupedMessages[account.address] = groupedMessages[account.address] || {}
                            let decryptedMessage = decryptContactRequestMessage(message, account)
                            if(isValidAddress(decryptedMessage.fromAddress) &&
                                 isValidAddress(decryptedMessage.fromKey)
                            ) {
                                groupedMessages[account.address][decryptedMessage.fromAddress] = groupedMessages[account.address][decryptedMessage.fromAddress] || []
                                groupedMessages[account.address][decryptedMessage.fromAddress].push(decryptedMessage)
                            }
                        }

                        Object.keys(groupedMessages).forEach(function (accountAddress) {
                            Object.keys(groupedMessages[accountAddress]).forEach(function (fromAddress) {
                                upateContactFromContactRequestMessages(groupedMessages[accountAddress][fromAddress])
                            })
                        })

                    }
                })
            }
        })
    }

    var decryptContactRequestMessage = function(message, toAccount) {
        let decrypted = {
            timestamp: message.timestamp,
            bundle: message.bundle,
            account: toAccount.address,
            command: message.command
        }
        if(message.fromKey){
            decrypted.fromKey = decrypt(message.fromKey, toAccount.privateKey).text
        }
        if(message.toKey){
            decrypted.toKey = decrypt(message.toKey, toAccount.privateKey).text
        }
        if(message.fromAddress){
            decrypted.fromAddress = decrypt(message.fromAddress, toAccount.privateKey).text
        }
        // TODO remove this section that uses old message format
        return decrypted
    }


    var upateContactFromContactRequestMessages = function(messages) {
        messages.sort((a,b) => {return a.timestamp - b.timestamp})
        let exists = contactsStore.find({
            account: messages[0].account,
            address: messages[0].fromAddress
        })
        let contact = exists[0]
        if(!contact) {
            createContact(messages[0])
                return
            }
        if(contact.blocked) {
            return
        }
        //logger.log("info", "upateContactFromContactRequestMessages contact %s", contact.name);

        messages.forEach(function(message){
            //logger.log("info", "upateContactFromContactRequestMessages message %j", message);

            if(isValidAddress(message.fromKey)) {
                updateActiveInboundMamRoots(contact, message.fromKey)
            }
        })
        //logger.log("info", "upateContactFromContactRequestMessages contact %s: activeMamRoots %j", contact.name, contact.activeMamRoots);
        showContactsList();
    }

    var createContact = function(message) {
        let exists = contactsStore.find({
            account: message.account,
            address: message.fromAddress
        })
        let contact = exists[0]
        if(!contact){
            // This is the first time seeing a message from this contact
            contact = contactsStore.insert({
                account: message.account,
                address: message.fromAddress,
                name: 'new contact',
            })
            initializeActiveMamState(contact)
        }
        contactsStore.update(contact)
        if(!contact.publicKey) {
            getPublicKey(message.fromAddress, function(error, publicKeys){
                publicKeys.forEach(function(publicKey){
                    let c = contactsStore.find({
                        address: publicKey.address,
                        account: message.account
                                        })
                    if(c && c.length === 1){
                        c[0].publicKey = publicKey.publicKey
                        c[0].name = publicKey.name
                        c[0].bundle = publicKey.bundle
                       contactsStore.update(c[0])
                        showContactsList();
                    } else {
                        logger.log('error', 'Found '+ c.length +' contacts for address '+publicKey.address)
                    }
                })
            })
        }
        return contact
    }

    var isValidAddress = function(address) {
        return address && iota.valid.isAddress(address)
    }

    /**
     *
     * @param {*} trytes - an array of transaction trytes
     *
     * @returns messages - an array of objects representing the data portions of each bundle
     */
    var messagesFromBundles = function(trytes) {
        var transactions = trytes.map(function (transactionTrytes) {
            return iota.utils.transactionObject(transactionTrytes);
        });
        var bundles = sortToBundles(transactions)
        var messages = []
        Object.keys(bundles).forEach(function(key, idx){
            var bundle = bundles[key]
            var message = JSON.parse(iota.utils.extractJson(bundle))
            if(message){
                message.timestamp = bundle[0].timestamp
                message.address = bundle[0].address
                message.bundle = key
                messages.push(message)
            }
        })
        return messages
    }

    var getBundleMessage = function(bundle) {
        var messageTrytes = ''
        bundle.forEach(function (transaction, idx) {
            messageTrytes += transaction.signatureMessageFragment;
        })
        return messageTrytes
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

    var refreshAccountKeys = function() {
        accountsStore.all().forEach(function (account, idx) {
            getPublicKey(account.address, function(error, publicKeys){
                setKeyStatus(error, publicKeys, account)
                accountsStore.update(account)
                showAccountsList()
            })
        })
        if(accountsStore.all().length == 1) {
            getPublicKey(getPublicKeyLabel(accountsStore.all()[0].publicKey), function(error, publicKey){
                // only called because of request bug that hangs sometimes
            })
        }
    }

    var refreshContactKeys = function() {
        let unique = {}
        contactsStore.all().forEach(function (contact, idx) {
            if(contact.address){
            getPublicKey(contact.address, function(error, publicKeys){
                setKeyStatus(error, publicKeys, contact)
                contact.name = publicKeys[0].name
                contact.publicKey = publicKeys[0].publicKey
                contactsStore.update(contact)
                showContactsList()
            })
            }
        })
       // if( contactsStore.all().length == 1) {
       //     getPublicKey(getPublicKeyLabel(  contactsStore.all()[0].publicKey), function(error, publicKey){
                // only called because of request bug that hangs sometimes
       //     })
       // }
    }

    /*
        updates all messages not in status: sent to status: error
    */
    var updateSendingMessages = function() {
        messagesStore.find({
                status: {'$ne' : MESSAGE_STATUS_SENT}
        }).forEach(function (message) {
            message.status = MESSAGE_STATUS_ERROR
            messagesStore.update(message)
        })
    }

   /*
        updates all contacts not in status: sent to status: error
    */
    var updateSendingContacts = function() {
        contactsStore.find({
                status: {'$ne' : MAM_ROOT_STATUS_SENT}
        }).forEach(function (contact) {
            contact.status = MAM_ROOT_STATUS_ERROR
            contactsStore.update(contact)
        })
    }

   /*
        updates all contacts not in status: sent to status: error
    */
    var updateSendingAccounts = function() {
         accountsStore.find({
                status: {'$ne' : PUBLICKEY_STATUS_OK}
        }).forEach(function (account) {
            account.keyStatus = PUBLICKEY_STATUS_ERROR
            accountsStore.update(account)
        })
    }

    /*
        set status and statusMessage on contact or account record
    */
    var setKeyStatus = function(error, publicKeys, user) {
        user.keyStatus = PUBLICKEY_STATUS_OK
        user.keyStatusMessage = ''
        if(error) {
            if(error.status !== undefined){
                user.keyStatus = error.status
            } else {
                user.keyStatus = PUBLICKEY_STATUS_ERROR
                user.keyStatusMessage = error.toString()
            }
        } else {
            if(publicKeys.length < 1) {
                user.keyStatus = PUBLICKEY_STATUS_NOT_FOUND
            } else if(publicKeys.length > 1) {
                user.keyStatus = PUBLICKEY_STATUS_MULTIPLE_FOUND
            } else if(publicKeys[0].address != user.address) {
                user.keyStatus = PUBLICKEY_STATUS_BAD_ADDRESS
            }
        }
    }

    /*
        UI handler callbacks
    */
    var addAccountResultsHandler = function(error, results) {
        if (error) {
            if(results && results.account) {
                results.account.keyStatus = PUBLICKEY_STATUS_ERROR
                logger.log('error', "addAccountResultsHandler error: %j", error)
                results.account.keyStatus = error.toString()
                accountsStore.update(results.account)
            }
        } else {
            if(results && results.account) {
                results.account.keyStatus = PUBLICKEY_STATUS_OK
                accountsStore.update(results.account)
            }
        }

        showAccountsList()
    }

    var sendMessageResultsHandler = function(error, results) {
        if (error) {
            logger.log('error', "sendMessageResultsHandler error: %j", error)
            if(results && results.message) {
                results.message.status = 'error'
                results.message.errorMessage = error
            }
        } else {
            if(results && results.message) {
                results.message.status = 'sent'
                let contact = getContact(results.message.to, results.message.from)
                setActiveMamState(contact, results.message.mamState)
            }
        }
        messagesStore.update(results.message)
        showMessageList()
    }

    var sendContactRequestResultsHandler = function(error, results) {
        if (error) {
            logger.log('error', "sendContactRequestResultsHandler error: %j", error)
            if(results && results.contact) {
                results.contact.mamRootStatus = MAM_ROOT_STATUS_ERROR
                results.contact.mamRootStatusMessage = "Error in sendContactRequestResultsHandler"+error
                contactsStore.update(results.contact)
                showContactsList()
            }
        } else {
            if(results && results.contact) {
                results.contact.mamRootStatus = MAM_ROOT_STATUS_SENT
                results.contact.mamRootStatusMessage = ''
            }
        }
        contactsStore.update(results.contact)
        showContactsList()
    }

    var addContactResultHandler = function(error, publicKeys) {
        if(error) {
            logger.log('error', "addContactResultHandler error: %j", error)
        } else {
            publicKeys.forEach(function(publicKey){
                var exists = contactsStore.find({
                    publicKey: publicKey.publicKey
                })
                if(exists.length === 0){
                    publicKey.newMessages = 0
                    contactsStore.insert(publicKey);
                }
            })
            showContactsList()
        }
    }


    /*
     functions for sending transactions to the Tangle
    */
    var sendTransfers = function(transfers, callback, callbackOptions={}) {

        // Validity check for number of arguments
        if (arguments.length < 2) {
            return callback(new Error("Invalid number of arguments"));
        }

        iota.api.prepareTransfers(seed, transfers, function (error, trytes) {
            if (error) return callback(error, callbackOptions)

            // Workaround to fix IRI bug https://github.com/iotaledger/iri/pull/340
            // Make sure transaction.tag == transaction.obsoleteTag
            var transactions = trytes.map(function (transactionTrytes) {
                return iota.utils.transactionObject(transactionTrytes);
            });
            for(var i = 0; i < transactions.length ; i++) {
                transactions[i].obsoleteTag = transactions[i].tag
            }
            trytes = transactions.map(function(transactionObject) {
                return iota.utils.transactionTrytes(transactionObject)
            })
            // END workaround
            addToSendingQueue(trytes, callback, callbackOptions)
        })
    }

    var addToSendingQueue = function(trytes, callback, callbackOptions) {
        const queueItem = {
            trytes: trytes,
            callback: callback,
            callbackOptions: callbackOptions
        }
       if(callbackOptions.message) {
            callbackOptions.message.status = MESSAGE_STATUS_QUEUEING
            messagesStore.update(callbackOptions.message)
            showMessageList()
        }
        sendingQueue.push(queueItem)
    }

    var sendNextMessage = function() {
        if(ccurlAvailable && sendingQueue.length > 0) {

            let queueItem = sendingQueue.shift()
            let callback = queueItem.callback
            let callbackOptions = queueItem.callbackOptions
            if(callbackOptions.message) {
                callbackOptions.message.status = MESSAGE_STATUS_POWING
                messagesStore.update(callbackOptions.message)
                showMessageList()
            }
            ccurlAvailable = false
            iota.api.sendTrytes(queueItem.trytes, tangleDepth, minWeightMagnitude, function (error, success) {
                ccurlAvailable = true
                if (error) {
                    return callback(error, callbackOptions);
                } else {
                    return callback(null, Object.assign({},success, callbackOptions))
                }
            })
        }
    }

    var getAccount = function(address) {
        var found = accountsStore.find({
            address: { '$regex': address }
        })
        if(found.length !== 1){
            logger.log('warning', "found "+found.length+" accounts for "+address)
        }
        return found[0]
    }

    var getContact = function(address, account) {
        var found = contactsStore.find({
            '$and' : [
                {address: { '$regex': address }},
                {account: account}
            ]
        })
        if(found.length !== 1){
            logger.log('warning', "warning: found "+found.length+" contacts for "+address)
        }
        return found[0]
    }

    /*
    The first 27 trytes of a public key address.
    */
    var getPublicKeyLabel = function(publicKey) {
        if(publicKey) {
            return createFingerprint(publicKey).substr(0,27);
        }
        return null
    }

    var getKeyUsername = function(publicKey) {
        let tag = getPublicKeyLabel(publicKey.publicKey) || (publicKey.address ? publicKey.address.substr(0,27) : '')
        return publicKey.name + '@' + tag
    }

    var getTagFromUsername = function(username) {
        return username.split('@')[1]
    }

    var getNameFromUsername = function(username) {
        return username.split('@')[0]
    }

    /*
    Creates a 81 tryte hash of the input.toString(). Intended for use as the address of a public key or a seed for a MAM channel
    */
    var createFingerprint = function(input, convertToTrytes=true) {
        if(convertToTrytes) {
            input = iota.utils.toTrytes(input.toString())
        }
        const curl = new Crypto.curl();
        const hash = new Int8Array(243);
        const messageTrits = Crypto.converter.trits(input);
        curl.initialize();
        curl.absorb(messageTrits, 0, messageTrits.length);
        curl.squeeze(hash, 0, hash.length);
        var fingerprint = Crypto.converter.trytes(hash).toString();
        return fingerprint;
    }

    /*
    Returns boolean about whether the given address matches the given publicKey and tag
    */
    var validatePublicKey = function(publicKey, address, tagOrAddress) {
        let addressMatchesTag = false
        if(tagOrAddress.length === 27 && address.substr(0,27) === tagOrAddress){
            addressMatchesTag = true
        } else if(address == tagOrAddress){
            addressMatchesTag = true
        }
        return addressMatchesTag && createFingerprint(publicKey) === address
    }

    var pendingContactInfo = function(contact) {
        switch(contact.mamRootStatus) {
            case MAM_ROOT_STATUS_SENDING:
                return '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span class="status">sending initial message key to <b>'+contact.name + '</b>...</span>'
            default:
                return ''
        }
    }

// UI functions

    var showMessenger = function() {
        $(".login_section").addClass("hidden");
        $(".messenger_section").removeClass("hidden");
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
                var tag = getPublicKeyLabel(account.publicKey)
                var userName = getKeyUsername(account)
                var deleteButton = '<input type="radio" name="account" id="deleteAccount' + tag + '" value="'+ userName +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
                var item
                var labelClass = account.address == currentAccount.address ? "current" : ""
                if(account.keyStatus === PUBLICKEY_STATUS_OK) {
                    item = '<input type="radio" name="fromAddress" id="fromAddress' + tag + '" value="'+ userName +'"><label id="accountLabel'+tag+'" class="'+labelClass+'" for="fromAddress'+ tag + '">' + userName + ' ' +deleteButton + '</label>'
                } else if(account.keyStatus === PUBLICKEY_STATUS_SENDING) {
                    item = '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span class="status">creating account <b>'+account.name + '</b>...</span>'
                } else if(account.keyStatus === PUBLICKEY_STATUS_NOT_FOUND) {
                    item = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span class="status">account <b>'+account.name + '</b> not found. <input type="radio" name="fromAddress" id="fromAddress' + tag + '" value="'+ userName +'"><button type="button" class="retry btn btn-default btn-xs"><span class="glyphicon glyphicon-repeat" aria-hidden="true"></span> Retry</button></span>'
                } else {
                    item = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span class="status">account <b>'+account.name + '</b> has a problem: '+account.keyStatus+'</span><button type="button" class="retry btn btn-default btn-xs"><span class="glyphicon glyphicon-repeat" aria-hidden="true"></span> Retry</button></span>'
                }
                $('#accountsList').append('<li id="'+ tag +'">' + item + '</li>')
            });
        }
    }

    var showContactsList = function() {
        $('#contactsList').empty()
        $('#deletedContactsList').empty();
        if(currentAccount) {
            var contacts = contactsStore.find({
                account: currentAccount.address
            })
            if(contacts && contacts.length > 0) {
                contacts.forEach(function (contact) {
                    let userName = getKeyUsername(contact)
                    if(!contact.deleted && !contact.error) {
                        //logger.log("info", "showContactsList %j", contact )
                        const isCurrentContact = currentContact && contact.address == currentContact.address
                        var tag = getPublicKeyLabel(contact.publicKey)
                        let deleteButton = '<input type="radio" name="contact" id="deleteContact' + tag + '" value="'+ contact.address +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
                        let newMessagesIndicator = contact.newMessages > 0 ? '<span class="new-messages">'+contact.newMessages +'</span>' : ''

                        var labelClass = isCurrentContact ? 'current' : ''
                        var icon = isCurrentContact ? deleteButton : newMessagesIndicator
                        var pendingInfo = pendingContactInfo(contact)
                        if(pendingInfo){
                            labelClass = 'pending'
                            pendingInfo = '<div class="pendingInfo">' +pendingInfo +'</div>'
                        }
                        $('#contactsList').append('<li id="'+ tag +'"><input type="radio" name="toAddress" id="toAddress' + tag + '" value="'+ userName +'"><label  id="contactLabel'+tag+'" class="'+labelClass+'"for="toAddress'+ tag + '">' + userName + ' ' + icon + "<br />"+ pendingInfo +'</label></li>')
                    } else {
                        var address = contact.address
                        $('#deletedContactsList').append('<li id="'+ address +'">' + userName + ' <input type="radio" name="address" id="address' + address + '" value="'+ address +'"><button type="button" class="unblock btn btn-default btn-xs"><span class="glyphicon glyphicon-user" aria-hidden="true"></span> Unblock</button></li>')
                    }
                });
            }
        }
    }

    var showMessageList = function() {
        var messagesList = $('#messagesList')
        messagesList.empty()
        if(currentContact) {
            currentContact.newMessages = 0
            contactsStore.update(currentContact)
            var fromAccount = getAccount(currentContact.account)
            var messages = messagesStore.find({
                '$or': [
                    {
                        '$and': [
                            {from: currentContact.address},
                            {to: currentContact.account}
                        ]
                    },{
                        '$and': [
                            {to: currentContact.address},
                            {from: currentContact.account}
                        ]
                    }
                ]
            })
            messages.forEach(function (message) {
                var inbound = message.from === currentContact.address
                var from = message.to === currentContact.address ?  fromAccount.name :  message.from === currentContact.address ? currentContact.name : null
                var messageId = message.$loki
                var deleteButton = '<input type="radio" name="message" id="deleteMessage' + messageId + '" value="'+ messageId +'"><a class="deleteMessage"><span class="glyphicon glyphicon-trash" aria-hidden="true"></span></a>'
                var info
                if(inbound || message.status === MESSAGE_STATUS_SENT) {
                    info = '<span class="time">' + formatTimestamp(message.timestamp) + '</span>'
                } else if(message.status === MESSAGE_STATUS_SENDING) {
                    info = '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span>sending...</span>'
                } else if(message.status === MESSAGE_STATUS_QUEUEING) {
                    info = '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span>queueing...</span>'
                } else if(message.status === MESSAGE_STATUS_POWING) {
                    info = '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span>doing POW...</span>'
                } else if(message.status === MESSAGE_STATUS_NOT_FOUND || message.status === MESSAGE_STATUS_ERROR) {
                    info = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span class="status">message not sent. <input type="radio" name="fromAddress" id="message' + messageId + '" value="'+ messageId +'"><button type="button" class="retry btn btn-default btn-xs"><span class="glyphicon glyphicon-repeat" aria-hidden="true"></span> Resend</button> </span> ' + deleteButton
                } else {
                    info = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span>error sending message.</span> ' + deleteButton
                }

                var scrollId = 'scrollTo' + messageId

                messagesList.append('<li class="message" id="'+ scrollId +'"><b>' + from + '</b> '+info+ '<br />'+message.text+'</li>')

            });
            $('#messageScroll').animate({scrollTop: $('#messageScroll').prop("scrollHeight")}, 100);

        }
    }







    /******************* Initialization functions *********************************/

    /* Initalize the app UI after login */
    var initialize = function(theSeed) {
        // We modify the entered seed to fit the criteria of 81 chars, all uppercase and only latin letters
        setSeed(theSeed);
        showMessenger();
        setDataStores();
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
                logger.log('error', error);
            } else {
                if (addresses.length != 1) {
                    logger.log('error', "no addresses found!");
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
        updateSendingContacts()
        updateSendingAccounts()
        refreshAccountKeys()
        refreshContactKeys()
        showAccountsList()
        showContactsList()
        Mam.init(iota)
        checkForNewMessages()
        checkMessageQueue()

        // temp
        //migrate()
    }

    var checkForNewMessages = function () {
        getMessages()
        getContactRequests()
        setTimeout(checkForNewMessages, MESSAGE_CHECK_FREQUENCY*1000)
    }

    var checkMessageQueue = function () {
        sendNextMessage()
        setTimeout(checkMessageQueue, 1000)
    }

    var initConfiguration = function() {
        var node_address = configuration.get('node_address').value
        $('#config_node_address').val(node_address)
        if(!validNodeAddress(node_address)) {
            toastr.warning('A valid node address is required. Set node address by clicking the <span class="glyphicon glyphicon-cog" rel="tooltip" title="Configuration"></span> icon.</a>')
        } else {
            iota = new IOTA({
                'provider': node_address
            });
            iota.api.getNodeInfo(function (error, results) {
                if(error || !results) {
                    toastr.warning(node_address + ' returned an error. Set node address by clicking the <span class="glyphicon glyphicon-cog" rel="tooltip" title="Configuration"></span> icon above.')
                } else if(results.latestMilestoneIndex !== results.latestSolidSubtangleMilestoneIndex) {
                    toastr.warning( node_address + ' is not fully synced. You may not be able to send messages.')
                } else {
                    toastr.success('Node configuration is complete.', null, {timeOut: 700})
                }
            })
        }
    }


    /****************** UI Event handlers ********************/

    $("#login").on("click", function () {
        var seed_ = $("#userSeed").val();
        var check = validateSeed(seed_);
        if (!check["valid"]) {
            showLogin(check["message"]);
            return;
        }
        $("#login-message").addClass("hidden");
        // We modify the entered seed to fit the criteria of 81 chars, all uppercase and only latin letters
        initialize(seed_);
    });

    $("#logoutBtn").on("click", function () {
        setSeed('');
        showLogin();
    });

    $("#add_contact").on("click", function () {
        var username = $("#contact_address").val()
        $("#contact_address").val('')
        initializeContact(currentAccount, username)
    });

    $("#create_account").on("click", function () {
        var name = $("#name").val()
        $("#name").val('')
        createAccount(name)
    })

    $("#save_config").on("click", function () {
        [
            'node_address'
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
        copyToClipboard(username)
        setCurrentContact(getContact(getTagFromUsername(username), currentAccount.address))
    });

    $('#contactsList').on('click','a.delete',function(event) {
        var address = $(this).prev().val()
        var contact = getContact(address, currentAccount.address)
        var messages = messagesStore.find({
            '$or': [
                {
                    '$and': [
                        {from: currentContact.address},
                        {to: currentContact.account}
                    ]
                },{
                    '$and': [
                        {to: currentContact.address},
                        {from: currentContact.account}
                    ]
                }
            ]
        })
        var confirmMessage = "Are you sure you want to delete contact "+ getKeyUsername(contact) + "?"
        if(messages.length > 0) {
            confirmMessage += "\n\nThis will delete "+messages.length+" messages between you and this contact."
        }
        if(confirm(confirmMessage)){
            messagesStore.remove(messages)
            contactsStore.remove(contact)
        }
        showContactsList()
        //showMessageList()
    });

    $('#deletedContactsList').on('click','button.unblock',function(event) {
        var address = $(this).prev().val()
        var contact = getContact(address, currentAccount.address)
        contactsStore.remove(contact)
        showContactsList()
    });

    $('#accountsList').on('click','label',function() {
        var username = $(this).prev().val()
        copyToClipboard(username)
        setCurrentAccount(getAccount(getTagFromUsername(username)))
        showContactsList()
    });

    $('#accountsList').on('click','a.delete',function(event) {
        var username = $(this).prev().val()
        var contact = getAccount(getTagFromUsername(username))
        var messages = messagesStore.find({
            '$or': [
                {from: { '$in' :[contact.address]}},
                {to: { '$in' :[contact.address]}}
            ]
        })
        var confirmMessage = "Are you sure you want to delete account "+ username + "?"
        if(messages.length > 0) {
            confirmMessage += "\n\nThis will delete "+messages.length+" messages to and from this account."
        }
        if(confirm(confirmMessage)){
            messagesStore.remove(messages)
            accountsStore.remove(contact)
            if(currentContact && currentContact.address === contact.address) {
                currentContact = null
            }
        }
        showAccountsList()
    });

    $('#accountsList').on('click','button.retry',function() {
        var username = $(this).prev().val()
        currentAccount = getAccount(getTagFromUsername(username))
        sendAccount(currentAccount)
        showMessageList();
    });

    $("#send_message").on("click", function () {
        var message = $("#message").val();
        $("#message").val('');
        if(message.match(/^\s*$/)) {
            toastr.warning("Message is blank!")
        } else if(!(currentAccount && currentContact)) {
            toastr.warning("Select an <b>Account</b> to send from and a <b>Contact</b> to send to.")
        } else {
            createMessage(message, currentContact)
        }
    })

    $('#messagesList').on('click','button.retry',function() {
        var messageId = $(this).prev().val()
        var results = messagesStore.find({$loki: parseInt(messageId)})
        // TODO check and handle cases where results.length != 1
        resendMessage(results[0])
    });

    $('#getMessages').on('click',function() {
        getMessages()
    });

    $('#messagesList').on('click','a.deleteMessage',function() {
        var messageId = $(this).prev().val()
        messagesStore.remove(messagesStore.find({$loki: parseInt(messageId)}))
        showMessageList()
    });

    $("#userSeed").on("keydown keyup", function(e) {
        if (e.keyCode == 13 && !$("#login").is(":disabled")) {
          $("#login").trigger("click");
        }

        var seed = $(this).val();
        $checksum = $("#seedChecksum");

        $checksum.removeClass();

        if (!seed) {
          $checksum.html("<span class='glyphicon glyphicon-question-sign' aria-hidden='true'></span>").attr("title", "");;
        } else if (seed.match(/[^A-Z9]/) || seed.match(/^[9]+$/)) {
          $checksum.html("<i class='glyphicon glyphicon-exclamation-sign' aria-hidden='true'></i>").addClass("invalid icon").attr("title", "Seed is too simple");
        } else if (seed.length < 81) {
          $checksum.html("<i class='glyphicon glyphicon-exclamation-sign' aria-hidden='true'></i> &lt;81").addClass("invalid").show().attr("title", "Seed is too short");
        } else if (seed.length > 81) {
          $checksum.html("<i class='glyphicon glyphicon-exclamation-sign' aria-hidden='true'></i> &gt;81").addClass("invalid").show().attr("title", "Seed is too long");
        } else {
          try {
            var checksum = iota.utils.addChecksum(seed, 3, false).substr(-3);
            if (checksum != "999") {
              $checksum.html("<i class='glyphicon glyphicon-ok-sign' aria-hidden='true'></i> " + checksum).addClass("validChecksum").attr("title", "Seed Checksum");
            } else {
              $checksum.html("<i class='glyphicon glyphicon-exclamation-sign' aria-hidden='true'></i>").addClass("invalid icon").attr("title", "Seed is not valid");
            }
          } catch (err) {
            $checksum.html("<i class='glyphicon glyphicon-exclamation-sign' aria-hidden='true'></i>").addClass("invalid icon").attr("title", "Seed is not valid");
          }
        }

        seed = "";
      });

    // Set globals
    var setCurrentAccount = function(account) {
        currentAccount = account
        currentContact = null
        if(currentAccount && currentAccount.publicKey){
            var tag = getPublicKeyLabel(currentAccount.publicKey)
            $('#accountsList label').removeClass("current")
            $('#contactsListHolder').removeClass("hidden")
            $('#accountLabel'+tag).addClass("current")
            $('#contactListTitle').html("Contacts for "+ getNameFromUsername(getKeyUsername(currentAccount)))
        } else {
            $('#contactsListHolder').addClass("hidden")
            $('#contactListTitle').html("")
        }
        showMessageList()
    }

    var setCurrentContact = function(contact) {
        if(contact && contact.publicKey){
            currentContact = contact
            currentContact.newMessages = 0
            contactsStore.update(currentContact)
            var tag = getPublicKeyLabel(currentContact.publicKey)
            $('#contactsList label').removeClass("current")
            $('#newContactsList label').removeClass("current")
            $('#contactLabel'+tag).addClass("current")
        }
        showContactsList()
        showMessageList()
    }

    // Utilities

    var validNodeAddress = function(address) {
        if(!address) {
            return false
        }
        return address.match(/^https?:\/\/.+\:.+/)
    }

    var createDatastoreFilename = function(type, address) {
        return path.join(electron.remote.app.getPath('userData'), address + '.' + type + '.' + DATA_STORE_VERSION + '.data')
    }

    var copyToClipboard = function (text) {
        electron.clipboard.writeText(text)
        toastr.info("Copied to clipboard", null, {timeOut: 500})
    }

    var getCcurlPath = function() {
        var is64BitOS = process.arch == "x64";
        // TODO find a better way to manage packaged vs unpackaged file paths
        var isDev = process.env.NODE_ENV === 'development'
        var base_path = isDev ? path.join(electron.remote.app.getAppPath(), "lib", "ccurl") :
                            path.join(electron.remote.app.getAppPath(), "..", "lib", "ccurl")
        if (process.platform == "win32") {
            return path.join(base_path, "win" + (is64BitOS ? "64" : "32"))
        } else if (process.platform == "darwin") {
            return path.join(base_path, "mac")
        } else {
            return path.join(base_path, "lin" + (is64BitOS ? "64" : "32"))
        }
    }

    var copyObject = function(obj) {
        return JSON.parse(JSON.stringify(obj))
    }

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

    var localAttachToTangle = function(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback) {
        ccurlInterface(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, getCcurlPath(), callback)
    }
    iota.api.attachToTangle = localAttachToTangle;
    iota.api.__proto__.attachToTangle = localAttachToTangle;

});
