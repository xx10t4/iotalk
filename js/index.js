$(document).ready(function () {

    var IOTA = require('iota.lib.js');
    const Crypto = require('crypto.iota.js');
    var ntru = require('ntru');
    var fs = require("fs");
    var codec = require('text-encoding');
    var ccurlInterface = require('ccurl.interface.js')
    const path = require("path");
    const MessagesStore = require("./messages.js")
    //  Instantiate IOTA with provider 'http://localhost:14265'
    var iota = new IOTA({
        'host': 'http://iota1/',
        'port': 14265
    });

    var messagesStore;

    // global state
    var seed;
    var localData = {accounts:[],contacts:[]};
    var currentAccount;
    var currentContact;
    var value = 0; // TODO need proper forwarding of remainder values before we can allow value to be sent
    var minWeightMagnitude = 15;
    var tangleDepth = 4;
    const IOTALKMESSAGE_TAG = 'IOTALKMESSAGE99999999999999'

    var sendTransfers = function(transfers, depth, minWeightMagnitude, callback) {

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
            if (error) return callback(error)

            iota.api.getTransactionsToApprove(depth, function (error, toApprove) {
                if (error) return callback(error)

                ccurlInterface(toApprove.trunkTransaction, toApprove.branchTransaction, minWeightMagnitude, trytes, ccurlPath, function (error, attached) {
                    if (error) return callback(error)

                    iota.api.storeTransactions(attached, function (error, success) {
                        if (error) return callback(error);
                    })
                    iota.api.broadcastTransactions(attached, function (error, success) {
                        if (error) return callback(error);
                        return callback(null, success)
                    })
                    iota.api.getNodeInfo(function (error, results) {})
                })
            })
        })
    }

    var getPublicKey = function(tag, callback) {
        iota.api.findTransactions({ tags: [tag] }, function (error, result) {
            if (error) {
                return callback(error);
            } else if (result.length == 0) {
                // handle empty results
                return callback("no results in findTransactions callback for tag "+ tag);
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
        cipherText =  Buffer.from(cipherText, 'base64').toString('utf-8')
        var decoded = []
        cipherText.split('').forEach(function(char){
            decoded.push(char.charCodeAt(0))
        })
        var encodedCipher = new Uint8Array(decoded)
        privateKey = new Uint8Array(privateKey.split(','))
        try{
            var encodedMessage = ntru.decrypt(encodedCipher, privateKey);
            return new codec.TextDecoder().decode(encodedMessage);
        } catch(error) {
            return error.toString()
        }
    }

    var sendMessage = function(messageText) {

        var messageTo = currentContact
        var messageFrom = currentAccount
        var messageFromFingerprint = createPublicKeyFinderprint(messageFrom.publicKey)
        var message = JSON.stringify({
            to: messageTo.fingerprint,
            from: encrypt(messageFromFingerprint, messageTo.publicKey),
            body: encrypt(messageText, messageTo.publicKey),
            replyAddress: encrypt(messageFrom.address, messageTo.publicKey)
        })
        
        var transfer = [{
            'address': messageTo.address,
            'value': 0,
            'message': iota.utils.toTrytes(message),
            'tag': IOTALKMESSAGE_TAG
        }]
    
        sendTransfers(transfer, tangleDepth, minWeightMagnitude, sendMessageResultsHandler)
        messagesStore.insert({
            text: messageText,
            to: messageTo.fingerprint,
            from: messageFromFingerprint,
            timestamp: new Date(),
            address: messageTo.address
        })
        showWaiting("Sending message... this may take a few minutes.");                

    }

    var getMessages = function(callback) {

        addresses = []
        for( var i = 0 ; i < localData.accounts.length ; i++) {
            var address = localData.accounts[i].address
            if(addresses.indexOf(address) < 0){
                addresses.push(address)
            }
        }
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
                            var timestamp = bundles[bundleHash][0].timestamp
                            if(timestamp) {
                                timestamp = new Date(timestamp*1000)
                            }
                            var message = getBundleMessage(bundles[bundleHash])
                            message.timestamp = timestamp
                            messages.push(getBundleMessage(bundles[bundleHash]))
                        })
                        return callback(null, messages);
                    }
                });
            }
        });
        iota.api.getNodeInfo(function (error, results) {})
    }

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

                account = {
                    privateKey: privateKey,
                    publicKey: publicKey,
                    name: name,
                    address: address,
                    fingerprint: fingerprint
                }
                if (!localData.accounts) {
                    localData.accounts = [];
                }
                localData.accounts.push(account);
                var publicKeyMessage = {
                    publicKey: publicKey,
                    fingerprint: createPublicKeyFinderprint(publicKey),
                    name: name,
                }
                
                var transfer = [{
                    'address': address,
                    'value': parseInt(value),
                    'message': iota.utils.toTrytes(JSON.stringify(publicKeyMessage)),
                    'tag': getPublicKeyTag(publicKeyMessage.publicKey)
                }]
            
                sendTransfers(transfer, tangleDepth, minWeightMagnitude, addAccountResultsHandler)
                $("#submit").toggleClass("disabled");
                showWaiting("Creating account... this may take a few minutes.");                
                saveLocalData();
            }
        })
    }

    function saveLocalData() {
        var localDataJson = JSON.stringify(localData);
        fs.writeFile(getLocalDataFileName(), localDataJson, function (err) {
            if (err) {
                console.log(err)
                return err.toString();
            }
            showAccountsList();
            showContactsList();
        });
    }

    function loadLocalData(refreshKeys=false) {
        var fileName = getLocalDataFileName();
        if (fs.existsSync(fileName)) {
            fs.readFile(fileName, function (err, contents) {
                if (err) {
                    console.log(err)
                    return err.toString();
                }
                localData = JSON.parse(contents);
                if(refreshKeys) {
                    refreshAccountKeys();
                    refreshContactKeys();
                }
                showAccountsList();
                showContactsList();
                getMessages(getMessagesResultsHandler);
            });
        }
    }

    var refreshAccountKeys = function() {         
        localData.accounts.forEach(function (account, idx) {           
            getPublicKey(getPublicKeyTag(account.publicKey), function(error, publicKeys){
                var errorMsg = checkUser(error, publicKeys, account)
                if(errorMsg) {
                    account.error = errorMsg
                    localData.accounts[idx] = account
                    saveLocalData()
                }
            })
        })
        if(localData.accounts.length == 1) {
            getPublicKey(getPublicKeyTag(localData.accounts[0].publicKey), function(error, publicKey){
                // only called because of request bug that hangs sometimes
            })
        }
    }

    var refreshContactKeys = function() {         
        localData.contacts.forEach(function (contact, idx) {           
            getPublicKey(getPublicKeyTag(contact.publicKey), function(error, publicKeys){
                var errorMsg = checkUser(error, publicKeys, contact)
                console.log("contact"+contact)
                    
                if(errorMsg) {
                    console.log(errorMsg)
                    contact.error = errorMsg
                    localData.contacts[idx] = contact
                    saveLocalData()
                }
            })
        })
        if(localData.contacts.length == 1) {
            getPublicKey(getPublicKeyTag( localData.contacts[0].publicKey), function(error, publicKey){
                // only called because of request bug that hangs sometimes
            })
        }
    }

    var checkUser = function(error, publicKeys, user) {
        if(error) {
            return "Error getting publicKey key: "+error.toString()
        } 
        if(publicKeys.length < 1) { 
            return "getPublicKey returned "+publicKeys.length+" publicKeys"
        }
        if(publicKeys.length > 1) { 
            return "getPublicKey returned "+publicKeys.length+" publicKeys!"
        }
        if(publicKeys[0].fingerprint != createPublicKeyFinderprint(user.publicKey)) { 
            return "getPublicKey returned a key with a different fingerprint"
        }
        return false
    }

    /*
        UI handler callbacks
    */
    var addAccountResultsHandler = function(error, results) {
        showMessenger();
        if (error) {

            var html = '<div class="alert alert-danger alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>ERROR!</strong>' + error + '.</div>'
            $("#send__success").html(JSON.stringify(error));

            $("#submit").toggleClass("disabled");

            $("#send__waiting").css("display", "none");

        } else {

            var html = '<div class="alert alert-info alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Success!</strong> You have successfully sentmessage.</div>'
            $("#send__success").html(html);

        }
    }

    var sendMessageResultsHandler = function(error, results) {
        showMessenger();
        if (error) {

            var html = '<div class="alert alert-danger alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>ERROR!</strong>' + error + '.</div>'
            $("#send__success").html(JSON.stringify(error));

            $("#submit").toggleClass("disabled");

            $("#send__waiting").css("display", "none");

        } else {

            var html = '<div class="alert alert-info alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Success!</strong> You have successfully sent a message.</div>'
            $("#send_message_success").html(html);

        }
    }

    var getMessagesResultsHandler = function(error, messages) {

        if(error) {
            console.log("in handler error:  " +error)
        } else {
            messages.forEach(function(message){
                if(message.to){
                    var account = getAccount(message.to)
                    var replyAddress = decrypt( message.replyAddress, account.privateKey)

                    messagesStore.upsert({
                        to: message.to,
                        from: decrypt(message.from, account.privateKey),
                        text: decrypt(message.body, account.privateKey)
                    })
                }
            })

        }
    }

    var addContactResultHandler = function(error, publicKeys) {

        publicKeys.forEach(function(publicKey){
            if (!localData.contacts) {
                localData.contacts = [];
            }
            var exists = false;
            for(var i = 0; i < localData.contacts.length ; i++){
                if(localData.contacts[i].publicKey === publicKey.publicKey){
                    exists = true;
                    break;
                }
            }
            if(!exists){
                localData.contacts.push(publicKey);
            }                   
        })
        saveLocalData(true);
    }

    var getAccount = function(tagOrFingerprint) {
        var func
        if(tagOrFingerprint.length == 27){
            func = getPublicKeyTag
        } else {
            func = createPublicKeyFinderprint
        }
        for(var i = 0 ; i < localData.accounts.length ; i++) {
            var account = localData.accounts[i]
            var accountTag = func(account.publicKey) 
            if(accountTag === tagOrFingerprint) {
               return account 
            }
        }
        return null
    }

    var getContact = function(tagOrFingerprint) {
        var tag = tagOrFingerprint.substr(0,27)
        for(var i = 0 ; i < localData.contacts.length ; i++) {
            var contact = localData.contacts[i]
            var contactTag = getPublicKeyTag(contact.publicKey)
            if(contactTag === tag) {
                return contact
            }
        }
        return null
    }

    var getLocalDataFileName = function() {
        return window.appRoot + "/data/" + seed.substr(0, 6) + ".json"
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
        loadLocalData(true);
    }

    var showAccountsList = function () {
        if (localData.accounts && localData.accounts.length > 0) {
            $('#accountsList').empty()
            localData.accounts.forEach(function (account) {
                if(!account.error) {
                    var tag = getPublicKeyTag(account.publicKey)
                    var userName = getKeyUsername(account) 
                    $('#accountsList').append('<li id="'+ tag +'"><input type="radio" name="fromAddress" id="fromAddress' + tag + '" value="'+ userName +'"><label for="fromAddress'+ tag + '">' + userName + '</li>')
                }
            });
        }
    }

    var showContactsList = function() {
        if(localData.contacts && localData.contacts.length > 0) {
            $('#contactsList').empty()
            localData.contacts.forEach(function (contact) {
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
            var accountfingerprint = createPublicKeyFinderprint(currentAccount.publicKey)
            var messages = messagesStore.find({
                from: { '$in' :[accountfingerprint, currentContact.fingerprint]},
                to: { '$in' :[accountfingerprint, currentContact.fingerprint]}
            })
            $('#messagesList').empty()
            messages.forEach(function (message) {
                var from = message.from === accountfingerprint ?  currentAccount :  message.from === currentContact.fingerprint ? currentContact : null
                if(from){
                    from = getKeyUsername(from) 
                }

                $('#messagesList').append('<li class="message"><b>' + from + '</b> <span class="time">' + formatTimestamp(message.timestamp) + '</span><br />'+message.text+'</label></li>')
            });
        }

    }

    var formatTimestamp = function(timestamp) {
        if(timestamp !== undefined) {
            console.log(JSON.stringify(new Date(timestamp)))
            return new Date(timestamp).toLocaleTimeString().toLowerCase()
        }
        return ''
    }

    function showWaiting(message) {
        $(".login_section").addClass("hidden");
        $(".messenger_section").addClass("hidden");
        $(".waiting_section").removeClass("hidden");
        $("#waiting_message").html(message);
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

    function validateSeed(value) {
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
    function setSeed(value) {
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

    function setMessagesStore() {
        iota.api.getNewAddress(seed, { 'checksum': true, total: 1, index: 0 }, function (error, addresses) {
            if (error) {
                console.log(error);
            } else {
                if (addresses.length != 1) {
                    console.log("no addresses found!");
                    return;
                }
                var address = addresses[0];
                messagesStore = new MessagesStore(seed, address+'.data')
            }
        })       
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
        setMessagesStore()
        showMessenger();
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
        console.log("currentAccount: "+currentAccount)
        $('#accountsList label').removeClass("current")   
        $(this).addClass("current")
    });

    $("#send_message").on("click", function () {
        var message = $("#message").val();
        $("#message").val('');
         sendMessage(message)
    })

});
