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
    const MessagesStore = require("./messages.js")
    const AccountsStore = require("./accounts.js")
    const ContactsStore = require("./contacts.js")
    const ConfigurationStore = require("./configuration.js")

    const LOG_LEVEL = 'error' // valid values: 'debug', 'warning', 'error'

    // Initialize with bogus config until the real config is loaded
    var iota = new IOTA({
        'provider': ''
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
    var minWeightMagnitude = 14;
    var tangleDepth = 4;
    const MESSAGE_CHECK_FREQUENCY = 30 // seconds

    // status codes for account and contact public keys (user.keyStatus)
    const PUBLICKEY_STATUS_OK = 'ok'
    const PUBLICKEY_STATUS_NOT_FOUND = 'not_found'
    const PUBLICKEY_STATUS_MULTIPLE_FOUND = 'multiple_found'
    const PUBLICKEY_STATUS_ERROR = 'error'
    const PUBLICKEY_STATUS_BAD_ADDRESS = 'bad_address'
    const PUBLICKEY_STATUS_SENDING = 'sending'

    // status codes for MAM root exchange (contact.mamRootStatus)
    const MAM_ROOT_STATUS_PENDING = 'pending'
    const MAM_ROOT_STATUS_ERROR = 'error'
    const MAM_ROOT_STATUS_SENT_INIT = 'sent_init'
    const MAM_ROOT_GET_PUBLIC_KEY = 'get_public_key'
    const MAM_ROOT_STATUS_RECEIVED_INIT = 'received_init'
    const MAM_ROOT_STATUS_SENDING_CONFIRM = 'sending_confirm'
    const MAM_ROOT_STATUS_SENT_CONFIRM = 'sent_confirm'
    const MAM_ROOT_STATUS_ACCEPTED = 'accepted'
    const MAM_ROOT_STATUS_BLOCKED = 'blocked'

    // status codes for outgoing messages (message.status)
    const MESSAGE_STATUS_SENT = 'sent'
    const MESSAGE_STATUS_NOT_FOUND = 'not_found'
    const MESSAGE_STATUS_ERROR = 'error'
    const MESSAGE_STATUS_SENDING = 'sending'
    const MAM_ROOT_TAG = 'MAM9ROOT9999999999999999999'

    var sendTransfers = function(transfers, depth, minWeightMagnitude, callback, callbackOptions={}) {

        // Validity check for number of arguments
        if (arguments.length < 4) {
            return callback(new Error("Invalid number of arguments"));
        }

        var ccurlPath = getCcurlPath();

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
                log('error', "createAccount error: "+error);
            } else {
                if (addresses.length != 1) {
                    log('error', "createAccount no addresses found!");
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
        sendTransfers(transfer, tangleDepth, minWeightMagnitude, addAccountResultsHandler, {account: account})
        showAccountsList();
    }

    var initializeContact = function(fromAccount, username) {

        tag = getTagFromUsername(username)
        getPublicKey(tag, function(error, publicKeys){
            if(error) {
                log('error', "initializeContact error: "+error)
            } else {
                let contact = null;
                publicKeys.forEach(function(publicKey){
                    var exists = contactsStore.find({
                        publicKey: publicKey.publicKey,
                        account: fromAccount.address
                    })
                    if(exists.length === 0){
                        publicKey.newMessages = 0
                        publicKey.account = fromAccount.address
                        contact = publicKey
                        contactsStore.insert(publicKey);
                    } else {
                        contact = exists[0]
                    }
                })
                if(contact){
                    sendContactRequest(fromAccount, contact)
                }
            }
        })
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

    var sendContactRequest = function(fromAccount, toContact) {

        if(!toContact.mamState){
        let mamState = Mam.changeMode(Mam.init(iota), 'private')
        let mamMessage = Mam.create(mamState, 'Initial Message')
            toContact.mamState = mamMessage.state
        }

        var publicKey = toContact.publicKey
        var fromMamRoot = toContact.mamState.channel.next_root
        var fromAddress = fromAccount.address
        var tangleMessage = {
            fromMamRoot: encrypt(fromMamRoot, publicKey),
            fromAddress: encrypt(fromAddress, publicKey)
        }

        var transfer = [{
            address: toContact.address,
            value: 0,
            message: iota.utils.toTrytes(JSON.stringify(tangleMessage)),
            tag: MAM_ROOT_TAG
        }]

        toContact.mamRootStatus = MAM_ROOT_STATUS_PENDING
        toContact.account = fromAddress
        contactsStore.update(toContact)

        sendTransfers(transfer, tangleDepth, minWeightMagnitude, sendContactRequestResultsHandler, {contact: toContact})
        showContactsList();
    }

    var sendContactRequestConfirmation = function(toContact, resultsHandlerCallback) {
        if(!toContact.mamState){
            let mamState = Mam.changeMode(Mam.init(iota), 'private')
            let mamMessage = Mam.create(mamState, 'Initial Message')
            toContact.mamState = mamMessage.state
        }
        var publicKey = toContact.publicKey
        var fromMamRoot = toContact.mamState.channel.next_root
        var toMamRoot = toContact.fromMamRoot // The MAM root that the contact previously sent to this user
        var tangleMessage = {
            fromMamRoot: encrypt(fromMamRoot, publicKey),
            toMamRoot: encrypt(toMamRoot, publicKey),
            fromAddress: encrypt(toContact.account, publicKey)
        }

        var transfer = [{
            address: toContact.address,
            value: 0,
            message: iota.utils.toTrytes(JSON.stringify(tangleMessage)),
            tag: MAM_ROOT_TAG
        }]

        toContact.mamRootStatus = MAM_ROOT_STATUS_SENDING_CONFIRM
        contactsStore.update(toContact)

        sendTransfers(transfer, tangleDepth, minWeightMagnitude, resultsHandlerCallback, {contact: toContact})
        showContactsList();
    }

    /*
        creates a new message and sends the public key to the tangle
    */
    var createMessage = function(messageText, toContact) {

        let mamState  = getOutboundMamState(toContact)
        debug('createMessage '+messageText+ ' mamteState', mamState)
        let mamMessage = Mam.create(mamState, iota.utils.toTrytes(messageText))
        let localMessage = {
            text: messageText,
            to: toContact.address,
            mamState: mamMessage.state,
            mamAddress: mamMessage.address,
            mamRoot: mamMessage.root,
            status: MESSAGE_STATUS_SENDING
       }
       localMessage = messagesStore.insert(localMessage)
       sendMessage(mamMessage, localMessage)
    }

    var getOutboundMamState = function(toContact) {
        var messages = messagesStore.find({
            to: toContact.address
        })
        let mamState = null
        if(messages.length > 0 && messages[messages.length - 1].mamState) {
            let message = messages[messages.length - 1]
            debug('getOutboundMamState from message', message)
            mamState = message.mamState
        } else {
            debug('getOutboundMamState from contact', toContact)
            mamState = toContact.mamState
        }
        return JSON.parse(JSON.stringify(mamState))
    }

    var getInoundMamRoot = function(fromContact) {
        var messages = messagesStore.find({
            from: fromContact.address
        })
        let fromMamRoot = null
        if(messages.length > 0 && messages[messages.length - 1].nextRoot) {
            let message = messages[messages.length - 1]
            debug('getInoundMamRoot from message', message)
            fromMamRoot = message.nextRoot
        } else {
            debug('getInoundMamRoot from contact', fromContact)
            fromMamRoot = fromContact.fromMamRoot
        }
        return fromMamRoot
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
        localMessage.timestamp = dateToTimestamp()
        messagesStore.update(localMessage)

        sendTransfers(transfer, tangleDepth, minWeightMagnitude, sendMessageResultsHandler, {message: localMessage})
        showMessageList();
    }

    var resendMessage = function(message) {
        if(message){
            var text = message.text
            var contact = getContact(message.to)
            messagesStore.remove(message)
            createMessage(text, contact)
        }
    }

    var getMessages = function() {

        Mam.init(iota)
        contactsStore.find({}).forEach(function(contact){
            if(contact.mamRootStatus !== MAM_ROOT_STATUS_BLOCKED) {
                var mamRoot = getInoundMamRoot(contact)
                if(mamRoot) {
                    const fetch = async () => {
                        var result = await Mam.fetch(mamRoot, 'private')
                        if(result) {
                            var nextRoot = result.nextRoot
                            result.messages.map(function(message){
                                return iota.utils.fromTrytes(message)
                            }).forEach(function(message){
                                let localMessage = {
                                    text: message,
                                    from: contact.address,
                                    nextRoot: nextRoot,
                                    timestamp: dateToTimestamp()
                               }
                               messagesStore.insert(localMessage)
                            })
                            showMessageList()
                        }
                    }
                    fetch()
                }
            }
        })
    }

    var getContactRequests = function() {
        var accounts = accountsStore.all()
        var addresses = accounts.map(function(account){ return account.address})
        iota.api.findTransactions({ addresses: addresses, tags: [MAM_ROOT_TAG]}, function (error, result) {
            if (error) {
                log('error',"Error in getContactRequests",error)
            } else if (result.length == 0) {
                // handle empty results
                log('warning',"no results in getContactRequests callback for addresses",addresses)
            } else {
               debug("getContactRequests findTransactions result", result);
                iota.api.getTrytes(result, function (error, trytes) {
                    if (error) {
                        log('error', error);
                    } else {
                        var messages = messagesFromBundles(trytes);
                        for( var i = 0; i < messages.length; i++) {
                            var message = messages[i]
                            var account = accounts.find((acc) => { return acc.address === message.address})
                            if(!account) {
                                log('error', "No account exists for contact request to address "+ message.address)
                                continue
                            }
                            var fromAddress = null
                            var fromMamRoot = null
                            var toMamRoot = null
                            if(message.fromMamRoot){
                                fromMamRoot = decrypt(message.fromMamRoot, account.privateKey).text
                            }
                            if(message.toMamRoot){
                                toMamRoot = decrypt(message.toMamRoot, account.privateKey).text
                            }
                            if(message.fromAddress){
                                fromAddress = decrypt(message.fromAddress, account.privateKey).text
                            }
                            if(isValidAddress(fromAddress) && isValidAddress(fromMamRoot))  {

                                var exists = contactsStore.find({
                                    account: account.address,
                                    address: fromAddress
                                })
                                var contact = exists[0]
                                if(contact && (contact.mamRootStatus === MAM_ROOT_STATUS_ACCEPTED || contact.mamRootStatus === MAM_ROOT_STATUS_BLOCKED)) {
                                    continue
                                }
                                if(!contact){
                                    // This is the first time seeing a message from this contact
                                    contact = contactsStore.insert({
                                        address: fromAddress,
                                        account: account.address,
                                        fromMamRoot: fromMamRoot,
                                        mamRootStatus: MAM_ROOT_GET_PUBLIC_KEY
                                    })
                                }
                                if(contact.mamRootStatus === MAM_ROOT_GET_PUBLIC_KEY) {
                                    getPublicKey(fromAddress, function(error, publicKeys){
                                        publicKeys.forEach(function(publicKey){
                                            contact.publicKey = publicKey.publicKey
                                            contact.name = publicKey.name
                                            contact.bundle = publicKey.bundle
                                            contact.mamRootStatus = MAM_ROOT_STATUS_RECEIVED_INIT
                                            contactsStore.update(contact)
                                            showContactsList();
                                        })
                                    })
                                }
                                if(isValidConfirmationMessage(contact, toMamRoot)) {
                                    contact.fromMamRoot = fromMamRoot
                                    // This is a message from the contact confirming that they have the mamRoot from this contact
                                    if(contact.mamRootStatus === MAM_ROOT_STATUS_SENT_INIT) {
                                        sendContactRequestConfirmation(contact,function(error,results){
                                            // TODO handle errors. Resend confirmation?
                                            contact.mamRootStatus = MAM_ROOT_STATUS_ACCEPTED
                                            contactsStore.update(contact)
                                        })
                                    }
                                    contact.mamRootStatus = MAM_ROOT_STATUS_ACCEPTED
                                    contactsStore.update(contact)
                                }
                            } else {
                                log('error', "no valid fromAddress in contactRequest to address "+message.address)
                            }
                        }
                    }
                    showContactsList();
                });
            }
        });
    }

    var isValidAddress = function(address) {
        return address && iota.valid.isAddress(address)
    }

    var isValidConfirmationMessage = function(contact, toMamRoot) {
        return contact.mamState && isValidAddress(toMamRoot) && (toMamRoot === contact.mamState.channel.next_root)
    }
    /*
        Returns an array of tangle addresses for inbound messages to any of the accounts
    */
    var getInboundMessageAddresses = function() {
        var addresses = []
        // get addresses associated with account keys
        accountsStore.all().forEach(function(account) {
            var address = account.address
            if(addresses.indexOf(address) < 0){
                addresses.push(address)
            }
        })
        var messages = messagesStore.find({
            from: { '$in' : addresses}
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
                setStatus(error, publicKeys, account)
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
        contactsStore.all().forEach(function (contact, idx) {
            getPublicKey(contact.address, function(error, publicKeys){
                setStatus(error, publicKeys, contact)
                contactsStore.update(contact)
                showContactsList()
            })
        })
        if( contactsStore.all().length == 1) {
            getPublicKey(getPublicKeyLabel(  contactsStore.all()[0].publicKey), function(error, publicKey){
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
                log('error', "addAccountResultsHandler error: "+JSON.stringify(error))
                results.account.keyStatus = error.toString()
            }
        } else {
            if(results && results.account) {
                results.account.keyStatus = PUBLICKEY_STATUS_OK
            }
        }
        accountsStore.update(results.account)
        showAccountsList()
    }

    var sendMessageResultsHandler = function(error, results) {
        if (error) {
            log('error', "sendMessageResultsHandler error", error)
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

    var sendContactRequestResultsHandler = function(error, results) {
        if (error) {
            log('error', "sendContactRequestResultsHandler error: "+JSON.stringify(error))
            if(results && results.contact) {
                results.contact.mamRootStatus = MAM_ROOT_STATUS_ERROR
                results.contact.mamRootStatusMessage = "Error in sendContactRequestResultsHandler"+error
            }
        } else {
            if(results && results.contact) {
                results.contact.mamRootStatus = MAM_ROOT_STATUS_SENT_INIT
                results.contact.mamRootStatusMessage = ''
            }
        }
        contactsStore.update(results.contact)
        showContactsList()
    }

    var sendContactRequestConfirmationResultsHandler = function(error, results) {
       debug("sendContactRequestConfirmationResultsHandler results",results)
        if (error) {
            log('error', "sendContactRequestConfirmationResultsHandler error: ",JSON.stringify(error))
            if(results && results.contact) {
                results.contact.mamRootStatus = MAM_ROOT_STATUS_ERROR
                results.contact.mamRootStatusMessage = "Error in sendContactRequestConfirmationResultsHandler: "+error
            }
        } else {
            if(results && results.contact) {
                results.contact.mamRootStatus = MAM_ROOT_STATUS_SENT_CONFIRM
                results.contact.mamRootStatusMessage = ''
            }
        }
        contactsStore.update(results.contact)
        showContactsList()
    }

    var addContactResultHandler = function(error, publicKeys) {
        if(error) {
            log('error', "addContactResultHandler error: "+error)
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

    var getAccount = function(address) {
        var found = accountsStore.find({
            address: { '$regex': address }
        })
        if(found.length !== 1){
            log('error', "warning: found "+found.length+" accounts for "+address)
        }
        return found[0]
    }

    var getContact = function(address) {
        var found = contactsStore.find({
            address: { '$regex': address }
        })
        if(found.length !== 1){
            log('error', "warning: found "+found.length+" contacts for "+address)
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
        return "no public key "
    }

    var getKeyUsername = function(publicKey) {
        return publicKey.name + '@' + getPublicKeyLabel(publicKey.publicKey)
    }

    var getTagFromUsername = function(username) {
        return username.split('@')[1]
    }

    /*
    Creates a 81 tryte hash of the input.toString(). Intended for use as the address of a public key or a seed for a MAM channel
    */
    var createFingerprint = function(input) {
        const curl = new Crypto.curl();
        const hash = new Int8Array(243);
        const messageTrits = Crypto.converter.trits(iota.utils.toTrytes(input.toString()));
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

    var contactPendingIcon = function(contact) {
        var tag = getPublicKeyLabel(contact.publicKey)
        var userName = getKeyUsername(contact)
        switch(contact.mamRootStatus){

            case MAM_ROOT_STATUS_RECEIVED_INIT:
            case MAM_ROOT_STATUS_ACCEPTED:
                return '<input type="radio" name="acceptContact" id="acceptContact' + tag + '" value="'+ contact.address +'"><a class="accept"><span class="glyphicon glyphicon-ok-sign" aria-hidden="true"></span></a><input type="radio" name="contact" id="deleteContact' + tag + '" value="'+ contact.address +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
            case MAM_ROOT_STATUS_ERROR:
                if(contact.mamRootStatusMessage =~ /Error in sendContactRequestConfirmationResultsHandler/) {
                    return '<input type="radio" name="acceptContact" id="acceptContact' + tag + '" value="'+ contact.address +'"><a class="accept"><span class="glyphicon glyphicon-ok-sign" aria-hidden="true"></span></a><input type="radio" name="contact" id="deleteContact' + tag + '" value="'+ contact.address +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
                } else {
                    return null
                }
            case MAM_ROOT_STATUS_SENT_INIT:
                return ' contact request sent <input type="radio" name="contact" id="deleteContact' + tag + '" value="'+ contact.address +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
            case MAM_ROOT_STATUS_PENDING:
                return '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span class="status">sending request to <b>'+contact.name + '</b>...</span>'
            case MAM_ROOT_STATUS_SENDING_CONFIRM:
                return '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span class="status">accepted request from <b>'+contact.name + '</b>...</span><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
            case MAM_ROOT_STATUS_SENT_CONFIRM:
                return '<span class="glyphicon glyphicon-cog glyphicon-hourglass"></span> <span class="status">accepted request from <b>'+contact.name + '</b>...</span><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
            default:
                return null
        }
    }

// UI functions

    var showMessenger = function() {
        $(".login_section").addClass("hidden");
        $(".messenger_section").removeClass("hidden");
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
        var contacts = contactsStore.all()
        $('#contactsList').empty()
        $('#deletedContactsList').empty();
        if(contacts && contacts.length > 0) {
            contacts.forEach(function (contact) {
                //contactsStore.remove(contact)
                if(!contact.deleted && !contact.error) {
                    var tag = getPublicKeyLabel(contact.publicKey)
                    var userName = getKeyUsername(contact)
                    var labelClass = currentContact && contact.address == currentContact.address ? 'current' : ''
                    var icon = ''
                    var pendingIcon = contactPendingIcon(contact)
                    if(pendingIcon){
                        icon = pendingIcon
                    } else if(contact.newMessages > 0) {
                        icon = '<span class="new-messages">'+contact.newMessages+'</span>'
                    }
                    var newMessageCount = contact.newMessages
                    $('#contactsList').append('<li id="'+ tag +'"><input type="radio" name="toAddress" id="toAddress' + tag + '" value="'+ userName +'"><label  id="contactLabel'+tag+'" class="'+labelClass+'"for="toAddress'+ tag + '">' + userName + ' ' + icon + '</label></li>')
                } else {
                    var address = contact.address
                    var userName = '' //getKeyUsername(contact)
                    $('#deletedContactsList').append('<li id="'+ address +'">' + getKeyUsername(contact) + ' <input type="radio" name="address" id="address' + address + '" value="'+ address +'"><button type="button" class="unblock btn btn-default btn-xs"><span class="glyphicon glyphicon-user" aria-hidden="true"></span> Unblock</button></li>')
                }
            });
        }
    }

    var showMessageList = function() {
        if(currentContact) {
            var fromAccount = getAccount(currentContact.account)
            var messages = messagesStore.find({
                '$or': [{
                    from: currentContact.address
                  },{
                    to: currentContact.address
                  }]
            })
            for(var i = 0; i < newMessages.length; i++) {
                var newMessage = newMessages[i]
                if(newMessage.from == currentContact.address){
                    messages.push(newMessage)
                }
            }
            var messagesList = $('#messagesList')
            messagesList.empty()
            messages.forEach(function (message) {
               debug("showMessageList message", message)
               debug("showMessageList contact", currentContact)
                var inbound = message.from === currentContact.address
                var from = message.to === currentContact.address ?  fromAccount.name :  message.from === currentContact.address ? currentContact.name : null
                var messageId = message.$loki
                var deleteButton = '<input type="radio" name="message" id="deleteMessage' + messageId + '" value="'+ messageId +'"><a class="deleteMessage"><span class="glyphicon glyphicon-trash" aria-hidden="true"></span></a>'
                var info
                if(inbound || message.status === MESSAGE_STATUS_SENT) {
                    info = '<span class="time">' + formatTimestamp(message.timestamp) + '</span>'
                } else if(message.status === MESSAGE_STATUS_SENDING) {
                    info = '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span>sending...</span>'
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
                log('error', error);
            } else {
                if (addresses.length != 1) {
                    log('error', "no addresses found!");
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

    var validNodeAddress = function(address) {
        if(!address) {
            return false
        }
        return address.match(/^https?:\/\/.+\:.+/)
    }

    var createDatastoreFilename = function(type, address) {
        return path.join(electron.remote.app.getPath('userData'), address + '.' + type + '.data');
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
            return path.join(base_path, "win" + (is64BitOS ? "64" : "32"));
        } else if (process.platform == "darwin") {
            return path.join(base_path, "mac");
        } else {
            return path.join(base_path, "lin" + (is64BitOS ? "64" : "32"));
        }
    }

    var checkForNewMessages = function () {
        getMessages()
        getContactRequests()
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
       debug("contactsList contact", getContact(getTagFromUsername(username)))
        setCurrentContact(getContact(getTagFromUsername(username)))
    });

    $('#contactsList').on('click','a.accept',function(event) {
        var address = $(this).prev().val()
        var contact = getContact(address)
        var confirmMessage = "Are you sure you want to add contact "+ getKeyUsername(contact) + "?"
        if(confirm(confirmMessage)){
            sendContactRequestConfirmation(contact, sendContactRequestConfirmationResultsHandler)
        }
        showContactsList()
        //showMessageList()
    });

    $('#contactsList').on('click','a.delete',function(event) {
        var address = $(this).prev().val()
        var contact = getContact(address)
        var messages = messagesStore.find({
            '$or': [
                {from: { '$in' :[contact.address]}},
                {to: { '$in' :[contact.address]}}
            ]
        })
        var confirmMessage = "Are you sure you want to delete contact "+ getKeyUsername(contact) + "?"
        if(messages.length > 0) {
            confirmMessage += "\n\nThis will delete "+messages.length+" messages between you and this contact."
        }
        if(confirm(confirmMessage)){
            messagesStore.remove(messages)
            contactsStore.softRemove(contact)
        }
        showContactsList()
        //showMessageList()
    });

    $('#deletedContactsList').on('click','button.unblock',function(event) {
        var address = $(this).prev().val()
        var contact = getContact(address)
        contactsStore.remove(contact)
        showContactsList()
    });

    $('#accountsList').on('click','label',function() {
        var username = $(this).prev().val()
        copyToClipboard(username)
       debug("account",getAccount(getTagFromUsername(username)))
        setCurrentAccount(getAccount(getTagFromUsername(username)))
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
        if(currentAccount){
            var tag = getPublicKeyLabel(currentAccount.publicKey)
            $('#accountsList label').removeClass("current")
            $('#accountLabel'+tag).addClass("current")
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

    var log = function(level, message, object={}) {
        const log_levels = [
            'debug', 'warning', 'error'
        ]
        if(log_levels.indexOf(level) >= log_levels.indexOf(LOG_LEVEL)) {
            console.log(level + ': ' + message + ': '+JSON.stringify(object))
        }
    }

    var debug = function(message, object) {
       log('debug', message, object)
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
