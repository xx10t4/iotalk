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
    //  Instantiate IOTA with provider 'http://localhost:14265'
    var iota = new IOTA({
        //'host': 'http://iota.bitfinex.com',
        'host': 'localhost',
        //'host': 'http://iota1',node_address
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
    var value = 0; // TODO need proper forwarding of remainder values before we can allow value to be sent
    var minWeightMagnitude = 15;
    var tangleDepth = 4;
    const MESSAGE_CHECK_FREQUENCY = 30 // seconds
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

        var ccurlPath;

        var is64BitOS = process.arch == "x64";
        if (process.platform == "win32") {
            ccurlPath = path.join("lib", "ccurl", "win" + (is64BitOS ? "64" : "32"));
        } else if (process.platform == "darwin") {
            ccurlPath = path.join("lib", "ccurl", "mac");
        } else {
            ccurlPath = path.join("lib", "ccurl", "lin" + (is64BitOS ? "64" : "32"));
        }

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
            console.log("addAccountResultsHandler error: "+JSON.stringify(error))
            if(results && results.account) {
                results.account.status = PUBLICKEY_STATUS_ERROR
                console.log("addAccountResultsHandler results.account: "+JSON.stringify(results.account))
                results.message.errorMessage = error.toString()
            }
        } else {
            if(results && results.account) {
                console.log("addAccountResultsHandler results.account: "+JSON.stringify(results.account))
                results.account.status = PUBLICKEY_STATUS_OK
            }
        }
        accountsStore.update(results.account)
        console.log("addAccountResultsHandler after update: "+JSON.stringify(results.account))
        showAccountsList()
    }

    var sendMessageResultsHandler = function(error, results) {          
        if (error) {
            console.log("sendMessageResultsHandler error: "+JSON.stringify(error))
            if(results && results.message) {
                results.message.status = 'error'
                console.log("sendMessageResultsHandler results.message: "+JSON.stringify(results.message))
                results.message.errorMessage = error
            }
        } else {
            if(results && results.message) {
                console.log("sendMessageResultsHandler results.message: "+JSON.stringify(results.message))
                results.message.status = 'sent'
            }
        }
        messagesStore.update(results.message)
        console.log("sendMessageResultsHandler after update: "+JSON.stringify(results.message))
        showMessageList()
    }

    var getInboundMessagesResultsHandler = function(error, messages) {
        if(error) {
            console.log("in handler error:  " +error)
        } else {
            messages.forEach(function(message){
                if(message.to){
                    var account = getAccount(message.to)
                    if(account) {                
                        var from = decrypt(message.from, account.privateKey).text
                        var text = decrypt(message.body, account.privateKey).text
                        var replyAddress = decrypt(message.replyAddress, account.privateKey).text
                        if(from !== undefined && text !== undefined && replyAddress !== undefined) {
                            messagesStore.upsert({
                                to: message.to,
                                timestamp: message.timestamp,
                                address: message.address,
                                from: from,
                                text: text,
                                replyAddress: replyAddress
                            })
                        }
                    } else {
                        console.log("retrieved message for unknown account: "+JSON.stringify(message))
                    }
                }
            })
            showMessageList()
        }
    }

    /*
        Handles messages that may be stuck in 'sending' or 'error' states
    */
    var getSendingMessagesResultsHandler = function(error, messages) {
        console.log("getSendingMessagesResultsHandler")
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

    var createKeyPair = function() {
        return ntru.keyPair();
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

    function showMessenger() {
        $(".login_section").addClass("hidden");
        $(".messenger_section").removeClass("hidden");
        $(".waiting_section").addClass("hidden");
        setDataStores()

    }

    function showLogin(message = "") {
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
            $('#accountsList').empty()
            accounts.forEach(function (account) {
                var tag = getPublicKeyTag(account.publicKey)
                var userName = getKeyUsername(account) 
                var item
                if(account.status === PUBLICKEY_STATUS_OK) {
                    item = '<input type="radio" name="fromAddress" id="fromAddress' + tag + '" value="'+ userName +'"><label class="" for="fromAddress'+ tag + '">' + userName + '</label>'
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
        if(contacts && contacts.length > 0) {
            $('#contactsList').empty()
            contacts.forEach(function (contact) {
                if(!contact.error) {
                    var tag = getPublicKeyTag(contact.publicKey)
                    var userName = getKeyUsername(contact) 
                    $('#contactsList').append('<li id="'+ tag +'"><input type="radio" name="toAddress" id="toAddress' + tag + '" value="'+ userName +'"><label for="toAddress'+ tag + '">' + userName + '</label></li>')
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
            /*
            messages = messagesStore.find({
                 status: 'sending'
            })
            messages.forEach(function (message) {
                console.log(message.status)
                if (message.status === 'sending'){
                    message.status = MESSAGE_STATUS_NOT_FOUND
                    //messagesStore.update(message)

                }
            })
            */
            var messagesList = $('#messagesList')
            messagesList.empty()
            messages.forEach(function (message) {
                var inbound = message.from === currentContact.fingerprint
                var from = message.from === currentAccount.fingerprint ?  currentAccount :  message.from === currentContact.fingerprint ? currentContact : null
                if(from){
                    from = getKeyUsername(from) 
                }
                var messageId = message.$loki
                var info
                if(inbound || message.status === MESSAGE_STATUS_SENT) {
                    info = '<span class="time">' + formatTimestamp(message.timestamp) + '</span>'
                } else if(message.status === MESSAGE_STATUS_SENDING) {
                    info = '<span class="glyphicon glyphicon-refresh glyphicon-refresh-animate"></span> <span>sending...</span>'
                } else if(message.status === MESSAGE_STATUS_NOT_FOUND || message.status === MESSAGE_STATUS_ERROR) {
                    info = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span class="status">message not sent. <input type="radio" name="fromAddress" id="message' + messageId + '" value="'+ messageId +'"><button type="button" class="retry btn btn-default btn-xs"><span class="glyphicon glyphicon-repeat" aria-hidden="true"></span> Resend</button></span>'
                } else {
                    info = '<span class="glyphicon glyphicon-exclamation-sign"></span> <span>error sending message.</span>'
                }
                var scrollId = 'scrollTo' + messageId

                messagesList.append('<li class="message" id="'+ scrollId +'"><b>' + from + '</b> '+info+ '<br />'+message.text+'</li>')

                $('#messageScroll').animate({scrollTop: $('#messageScroll').prop("scrollHeight")}, 500);
            });
        }

    }

    function showWaiting(message) {
        $(".login_section").addClass("hidden");
        $(".messenger_section").addClass("hidden");
        $(".waiting_section").removeClass("hidden");
        $("#waiting_message").html(message);
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


        iota = new IOTA({
        //'host': 'http://iota.bitfinex.com',
        'host': node_address,
        //'host': 'http://iota1',node_address
        'port': node_port
    });
    }

    var createDatastoreFilename = function(type, address) {
        return path.join(electron.remote.app.getPath('userData'), address + '.' + type + '.data');
    }

    var checkForNewMessages = function () {
        getMessages(getInboundMessageAddresses(),getInboundMessagesResultsHandler)
        setTimeout(checkForNewMessages, MESSAGE_CHECK_FREQUENCY*1000)
    }

    // Event handlers

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
        var keys = [
            'node_address',
            'node_port'
        ].forEach(function(key){
            var config = configuration.get(key)            
            config.value = $("#config_"+key).val()
            configuration.set(config)
        })        
    })

    

    $('#contactsList').on('click','label',function() {
        var username = $(this).prev().val()
        currentContact = getContact(username.split('@')[1])
        showMessageList();
       $('#contactsList label').removeClass("current")   
        $(this).addClass("current")
    });

    $('#accountsList').on('click','label',function() {
        var username = $(this).prev().val()
        currentAccount = getAccount(username.split('@')[1])
        showMessageList();
        $('#accountsList label').removeClass("current")   
        $(this).addClass("current")
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
         createMessage(message, currentAccount, currentContact)
    })

    $('#messagesList').on('click','button.retry',function() {
        var messageId = $(this).prev().val()
        var results = messagesStore.find({$loki: parseInt(messageId)})
        // TODO check and handle cases where results.length != 1
        sendMessage(results[0])
    });
    


    // Utilities
    /*
        Returns a UNIX timestamp - number of seconds since the epoch
    */
    var dateToTimestamp = function(date = null) {
        if(date === null) {
            date = new Date();
        }
        return Math.floor(date.getTime()/1000);
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
