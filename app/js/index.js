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

    // Initialize with bogus config until the real config is loaded
    var iota = new IOTA({
        'provider': ''
    });
    const DEBUG = true

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
    const MESSAGE_CHECK_FREQUENCY = 120 // seconds

    // status codes for account and contact public keys
    const PUBLICKEY_STATUS_OK = 'ok'
    const PUBLICKEY_STATUS_NOT_FOUND = 'not_found'
    const PUBLICKEY_STATUS_MULTIPLE_FOUND = 'multiple_found'
    const PUBLICKEY_STATUS_ERROR = 'error'
    const PUBLICKEY_STATUS_BAD_ADDRESS = 'bad_address'
    const PUBLICKEY_STATUS_SENDING = 'sending'

    // status codes for MAM key exchange
    const MAM_ROOT_STATUS_PENDING = 'pending'
    const MAM_ROOT_STATUS_ERROR = 'error'
    const MAM_ROOT_STATUS_SENT_INIT = 'sent_init'
    const MAM_ROOT_GET_PUBLIC_KEY = 'get_public_key'
    const MAM_ROOT_STATUS_RECEIVED_INIT = 'received_init'
    const MAM_ROOT_STATUS_SENT_CONFIRM = 'sent_confirm'
    const MAM_ROOT_STATUS_ACCEPTED = 'accepted'
    const MAM_ROOT_STATUS_BLOCKED = 'blocked'

    // status codes for outgoing messages
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
                console.log("error: "+error)
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
                        console.log(JSON.stringify(exists))
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

        toContact.mamRootStatus = MAM_ROOT_STATUS_SENT_CONFIRM
        contactsStore.update(toContact)

        sendTransfers(transfer, tangleDepth, minWeightMagnitude, resultsHandlerCallback, {contact: toContact})
        showContactsList();
    }

    /*
        creates a new message and sends the public key to the tangle
    */
    var createMessage = function(messageText, fromAccount, toContact) {

        var messages = messagesStore.find({
            from: { '$in' :[fromAccount.address]},
            to: { '$in' :[toContact.address]}
        })
        let isFirstMessage = messages.length == 0

        let mamState
        if(isFirstMessage){
            mamState = toContact.mamState
        } else {
            mamState = messages[messages.length - 1].mamState
        }
        var mamMessage = Mam.create(mamState, messageText)

        var localMessage = {
            text: messageText,
            to: toContact.address,
            from: fromAccount.address,
            mamState: mamMessage.state,
            mamAddress: mamMessage.address,
            mamRoot: mamMessage.root
       }
       messagesStore.insert(localMessage)
       sendMamMessage(mamMessage, localMessage)
    }

    /*
        creates a tangle transaction bundle that publishes a message
    */
    var sendMamMessage = function(mamMessage, localMessage) {

        var transfer = [{
            'address': mamMessage.address,
            'value': 0,
            'message': mamMessage.payload
        }]

        localMessage.status = PUBLICKEY_STATUS_SENDING
        localMessage.timestamp = dateToTimestamp()
        messagesStore.update(localMessage)

        sendTransfers(transfer, tangleDepth, minWeightMagnitude, sendMessageResultsHandler, {message: localMessage})
        showMessageList();
    }

    var getMessages = function(addresses, callback) {

        var mamState = Mam.init(iota)


// Init State
let root = ''

// Initialise MAM State
var mamState = Mam.init(iota)
// Set channel mode
mamState = Mam.changeMode(mamState, 'private')
console.log('initial State: ', JSON.stringify(mamState))

// Publish to tangle
const publish = async packet => {
    // Create MAM Payload - STRING OF TRYTES
    console.log('---------- ')
    console.log('MESSAGE: ', packet)

    var message = Mam.create(mamState, packet)
    // Save new mamState
    mamState = message.state
    console.log('Root: ', message.root)
    console.log('Address: ', message.address)
    console.log('State: ', JSON.stringify(message.state))
    // Attach the payload.
    var transfer = [{
        address: message.address,
        value: 0,
        message: message.payload
    }]

   // sendTransfers(transfer, tangleDepth, minWeightMagnitude, sendMamHandler, {root: message.root})
}

publish('MESSAGEONE')

publish('MESSAGETWO')
publish('MESSAGETHREE')



/*

        Mam.changeMode(mamState, 'private')
        var mamMessage = Mam.create(mamState, "this is a message")

        var payload = mamMessage.payload
        var address = mamMessage.address
        //var root = mamMessage.address
        var state = mamMessage.state
        console.log("root "+root)
        console.log("address"+address)
        console.log("state "+JSON.stringify(state))
        console.log("payload" + payload)

       // var m = Mam.decode(payload, null, root )
       // log(m)
        iota.api.findTransactions({ addresses: addresses}, function (error, result) {
            if (error) {
                return callback(error);
            } else if (result.length == 0) {
                // handle empty results
                return callback("no results in findTransactions callback for addresses "+ JSON.stringify(addresses));
            } else {
                iota.api.getTrytes(result, function (error, trytes) {
                    if (error) {
                        return callback(error);
                    } else {
                        return callback(null,  messagesFromBundles(trytes));
                    }
                });
            }
        });
        iota.api.getNodeInfo(function (error, results) {})*/
    }

    var sendMamHandler = function(error, results) {

        console.log("error")
        console.log(JSON.stringify(error))
        console.log("results")
        console.log(JSON.stringify(results))

        // Fetch Stream Async to Test
        const fetch = async () => {
            await Mam.fetch(results.root, 'private', null, function(mesg){
                console.log("the message is "+ mesg)
            })
        }
        fetch()


    }

    var getContactRequests = function() {
        var accounts = accountsStore.all()
        var addresses = accounts.map(function(account){ return account.address})
        iota.api.findTransactions({ addresses: addresses, tags: [MAM_ROOT_TAG]}, function (error, result) {
            if (error) {
                console.log("Error in getContactRequests: "+JSON.stringify(error))
            } else if (result.length == 0) {
                // handle empty results
                console.log("no results in getContactRequests callback for addresses "+ JSON.stringify(addresses));
            } else {
                if(DEBUG) {
                    console.log("getContactRequests findTransactions result "+ JSON.stringify(result));
                }
                iota.api.getTrytes(result, function (error, trytes) {
                    if (error) {
                        console.log(error);
                    } else {
                        var messages = messagesFromBundles(trytes);
                        for( var i = 0; i < messages.length; i++) {
                            var message = messages[i]
                            var account = accounts.find((acc) => { return acc.address === message.address})
                            if(!account) {
                                console.log("No account exists for contact request to address "+ message.address)
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
                                console.log("no valid fromAddress in contactRequest to address "+message.address)
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

    var log = function(object){
        console.log(object+ ": "+JSON.stringify(object));
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
                console.log("addAccountResultsHandler error: "+JSON.stringify(error))
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

    var sendContactRequestResultsHandler = function(error, results) {
        if (error) {
            console.log("sendContactRequestResultsHandler error: "+JSON.stringify(error))
            if(results && results.contact) {
                results.contact.mamRootStatus = MAM_ROOT_STATUS_ERROR
                results.contact.mamRootStatusMessage = "Error in sendContactRequestResultsHandler: "+error
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
        if (error) {
            console.log("sendContactRequestConfirmationResultsHandler error: "+JSON.stringify(error))
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
                    if(!error && publicKeys && publicKeys[0].address === from){
                        var messages = newContacts[from]
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
            })
                showContactsList()
        }
    }

    var getAccount = function(address) {
        var found = accountsStore.find({
            address: { '$regex': address }
        })
        if(found.length !== 1){
            console.log("warning: found "+found.length+" accounts for "+address)
        }
        return found[0]
    }

    var getContact = function(address) {
        var found = contactsStore.find({
            address: { '$regex': address }
        })
        if(found.length !== 1){
            console.log("warning: found "+found.length+" contacts for "+address)
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
                    item = '<span class="glyphicon glyphicon-cog glyphicon-cog-animate"></span> <span class="status">creating  account <b>'+account.name + '</b>...</span>'
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
                    var labelClass = ''
                    var icon = ''
                    var pendingIcon = contactPendingIcon(contact)
                    if(pendingIcon){
                        icon = pendingIcon
                    } else if(currentContact && contact.address == currentContact.address){
                        labelClass = "current"
                        icon = '<input type="radio" name="contact" id="deleteContact' + tag + '" value="'+ contact.address +'"><a class="delete"><span class="glyphicon glyphicon-remove-sign" aria-hidden="true"></span></a>'
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
        if(currentAccount && currentContact) {
            var messages = messagesStore.find({
                from: { '$in' :[currentAccount.address, currentContact.address]},
                to: { '$in' :[currentAccount.address, currentContact.address]}
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
                var inbound = message.from === currentContact.address
                var from = message.from === currentAccount.address ?  currentAccount :  message.from === currentContact.address ? currentContact : null
                if(from){
                    from = getKeyUsername(from)
                }
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
        $('#config_node_address').val(node_address)
        if(!validNodeAddress(node_address)) {
            showAlert('warning', 'A valid node address is required. Set node address by clicking the <span class="glyphicon glyphicon-cog" rel="tooltip" title="Configuration"></span> icon above.</a>')
        } else {
            iota = new IOTA({
                'provider': node_address
            });
            iota.api.getNodeInfo(function (error, results) {
                if(error || !results) {
                    showAlert('warning', node_address + ' returned an error. Set node address by clicking the <span class="glyphicon glyphicon-cog" rel="tooltip" title="Configuration"></span> icon above.')
                } else if(results.latestMilestoneIndex !== results.latestSolidSubtangleMilestoneIndex) {
                    showAlert('warning', node_address + ' is not fully synced. You may not be able to send messages.')
                } else {
                    toastr.success('Node configuration is complete.', null, {timeOut: 1000})
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
        //getMessages(getInboundMessageAddresses(),getInboundMessagesResultsHandler)
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
        if(DEBUG){
            console.log("contact:"+JSON.stringify(getContact(getTagFromUsername(username))))
        }
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
        if(DEBUG){
            console.log("account:"+JSON.stringify(getAccount(getTagFromUsername(username))))
        }
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
            showAlert('warning',"Message is blank!")
        //} else if(!(currentAccount && currentContact)) {
        //    showAlert('warning',"Select an <b>Account</b> to send from and a <b>Contact</b> to send to.")
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
