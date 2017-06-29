$(document).ready(function () {

    var IOTA = require('iota.lib.js');
    const Crypto = require('crypto.iota.js');
    var ntru = require('ntru');
    var fs = require("fs");
    var codec = require('text-encoding');
    var ccurlInterface = require('ccurl.interface.js')
    const path = require("path");
    //  Instantiate IOTA with provider 'http://localhost:14265'
    var iota = new IOTA({
        'host': 'http://iota1/',
        'port': 14265
    });

    var seed;
    var localData = {accounts:[],contacts:[]};

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
                        //console.log("getTrytescallback: trytes: " + trytes)
                        var transactions = trytes.map(function (transactionTrytes) {
                            return iota.utils.transactionObject(transactionTrytes);
                        });
                        var max_index = Math.max.apply(Math, transactions.map(function (transaction, idx) {
                            return parseInt(transaction.currentIndex);
                        }));
                        if (transactions.length - max_index > 1) {
                            // we likely have a replayed bundle, need to remove duplicates (transactions with the same currentIndex)
                            keep = []
                            transactions.forEach(function (transaction, idx) {
                                var seen = keep[transaction.currentIndex];
                                if (!seen) {
                                    keep[transaction.currentIndex] = transaction;
                                } else if (seen.message != transaction.message) {
                                    // DO we need to validate duplicates and error if they are different?
                                }
                            });
                            transactions = keep;
                        }
                        transactionsSorted = transactions.sort(function (a, b) {
                            return a.currentIndex - b.currentIndex
                        });
                        var publicKeyTrytes = ''
                        addresses = []
                        transactionsSorted.forEach(function (transaction, idx) {
                            publicKeyTrytes += transaction.signatureMessageFragment;
                            var address = transaction.address;
                            if (addresses.indexOf(address) < 0) {
                                addresses.push(address);
                            }

                        });
                        // TODO sanity check - verify that all transactions were to the same address
                        // error if addresses.length != 1

                        // kluge to make sure it's an even # of chars for fromTrytes
                        if (publicKeyTrytes.length % 2 > 0) {
                            publicKeyTrytes += '9'
                        }
                        var decodedStr = iota.utils.fromTrytes(publicKeyTrytes);
                        var jsonStr = decodedStr.substr(0, decodedStr.lastIndexOf('}') + 1)
                        // TODO validate JSON
                        try {
                            publicKey = JSON.parse(jsonStr)
                        } catch(error) {
                            return callback(error)
                        }
                        publicKey.address = addresses[0]
                        if (validatePublicKey(publicKey.publicKey, publicKey.fingerprint)) {
                            return callback(null, publicKey);
                        }
                    }
                });
            }
        });
        iota.api.getNodeInfo(function (error, results) {})
    }

    function getKeyUsername(publicKey) {
        return publicKey.name + '@' + getPublicKeyTag(publicKey.publicKey)
    }

    var encryptMessage = function(message, publicKey) {
        publicKey = new Uint8Array(publicKey.split(','))
        var encoder = new codec.TextEncoder();
        var encodedMessage = encoder.encode(message);
        return ntru.encrypt(encodedMessage, publicKey);
    }

    var decryptMessage = function(cipherText, privateKey) {
        privateKey = new Uint8Array(privateKey.split(','))
        var encodedMessage = ntru.decrypt(cipherText, privateKey);
        var decoder = new codec.TextDecoder();
        return decoder.decode(encodedMessage);
    }

    var sendMessage = function(toContact, fromAccount, message) {

        fromAccount = getAccount('FUPBHEBJNVNUVABVFANYKPERGBO')
        console.log("from "+fromAccount.name)

        toContact = fromAccount
        console.log("to "+toContact.name)

        console.log("message "+message)
        var encrypted = encryptMessage(message, toContact.publicKey)
        console.log("encrypted "+encrypted)

        var decrypted = decryptMessage(encrypted, fromAccount.privateKey)
        console.log("decrypted "+decrypted)


    }

    function createAccount(name) {
        console.log("creatAddress with name: " + name)
        iota.api.getNewAddress(seed, { 'checksum': true, total: 1 }, function (error, addresses) {
            if (error) {
                console.log(error);
            } else {
                if (addresses.length != 1) {
                    console.log("no addresses found!");
                    return;
                }
                var value = 0; // TODO need proper forwarding of remainder values before we can allow value to be sent
                var minWeightMagnitude = 15;
                var tangleDepth = 4;
                var address = addresses[0];
                var newKeyPair = createKeyPair();
                var privateKey = newKeyPair.privateKey.toString();
                var publicKey = newKeyPair.publicKey.toString();
                var username = getKeyUsername({ name: name, publicKey: publicKey });

                account = {
                    privateKey: privateKey,
                    publicKey: publicKey,
                    name: name,
                    address: address
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
            
                sendTransfers(transfer, tangleDepth, minWeightMagnitude, sendTransferResultsHandler)
                $("#submit").toggleClass("disabled");
                showWaiting("Creating account... this may take a few minutes.");                
                saveLocalData();
            }
        })
    }

    function saveLocalData(refreshKeys=false) {
        var localDataJson = JSON.stringify(localData);
        fs.writeFile(getLocalDataFileName(), localDataJson, function (err) {
            if (err) {
                return console.log(err);
            }
            showAccountsList(refreshKeys);
            showContactsList(refreshKeys);
        });
    }

    function loadLocalData(refreshKeys=false) {
        var fileName = getLocalDataFileName();
        if (fs.existsSync(fileName)) {
            fs.readFile(fileName, function (err, contents) {
                if (err) {
                    return console.log(err);
                }
                localData = JSON.parse(contents);
                showAccountsList(refreshKeys);
                showContactsList(refreshKeys);
            });
        }
    }

    function retrieveAddressTransactions(address) {

        var params = { "addresses": [address] }
        // Broadcast and store tx
        iota.api.findTransactionObjects(params, function (error, success) {

            if (error) {
                $("#send__success").html(JSON.stringify(error));
            } else {
                console.log("success", success)
                var messageFromTrytes = iota.utils.fromTrytes(success[0]["signatureMessageFragment"]);
                messageObject = JSON.parse(messageFromTrytes)


                var results = JSON.stringify(success);
                var results = JSON.stringify(success);
                console.log("messageObject", messageObject)
                console.log("results", results)
                $("#send__success").html(results);
            }
        })
    }


    /*
        UI handler callbacks
    */
    var sendTransferResultsHandler = function(error, results) {
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

    var addContactResultHandler = function(error, publicKey){
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
        saveLocalData(true);
    }

    var getAccount = function(tag) {
         console.log("####localData.accounts.length "+localData.accounts.length)
        for(var i = 0 ; i < localData.accounts.length ; i++) {
            var accountTag = getPublicKeyTag(localData.accounts[i].publicKey)
            console.log("tag "+tag)
            console.log("accountTag "+accountTag)
            if(accountTag == tag) {
                return localData.accounts[i] 
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

    var showAccountsList = function (refreshKeys=false) {
        if (localData.accounts && localData.accounts.length > 0) {
            $('#accountsList').empty()
            localData.accounts.forEach(function (account) {
                $('#accountsList').append('<li id="'+getPublicKeyTag(account.publicKey)+'">' + getKeyUsername(account) + '</li>')
            });
            if(refreshKeys){              
                localData.accounts.forEach(function (account) {
                    
                    getPublicKey(getPublicKeyTag(account.publicKey), function(error, publicKey){
                        if(error) {
                            console.log("error getting publicKey key for "+ account);
                            console.log(error);
                        } else {
                            showAccountVerified(account)
                        }
                    });
                });
                if(localData.accounts.length == 1) {
                    var account = localData.accounts[0]
                    getPublicKey(getPublicKeyTag(account.publicKey), function(error, publicKey){
                        if(error) {
                            console.log("error getting publicKey key for "+ account);
                            console.log(error);
                        } else {
                            showAccountVerified(account)
                        }
                    });
                }          
            }
        }
    }

    function showAccountVerified(verifiedAccount, type='accounts') {
        console.log("showAccountVerified")
        if (localData[type] && localData[type].length > 0) {
            localData[type].forEach(function (account) {        
                if(verifiedAccount.publicKey === account.publicKey ){
                    $('#'+getPublicKeyTag(account.publicKey)).addClass("verified")
                }
            });
        }
    }

    function showContactsList(refreshKeys=false) {
        if(localData.contacts && localData.contacts.length > 0) {
            $('#contactsList').empty()
            localData.contacts.forEach(function (contact) {
                $('#contactsList').append('<li id="'+getPublicKeyTag(contact.publicKey)+'">' + getKeyUsername(contact) + '</li>')
            });
            if(refreshKeys){              
                localData.contacts.forEach(function (account) {
                    getPublicKey(getPublicKeyTag(account.publicKey), function(error, publicKey){
                        if(error) {
                            console.log("error getting publicKey key for "+ account);
                            console.log(error);
                        } else {
                            showAccountVerified(account, "contacts")
                        }
                    });
                });
                if(localData.contacts.length == 1) {
                    var account = localData.contacts[0]
                    getPublicKey(getPublicKeyTag(account.publicKey), function(error, publicKey){
                        if(error) {
                            console.log("error getting publicKey key for "+ account);
                            console.log(error);
                        } else {
                            showAccountVerified(account, "contacts")
                        }
                    });
                }          
            }
        }
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



    //
    // Set seed
    //
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

    $("#submit_receive_address").on("click", function () {

        var address = $("#address").val();
        retrieveAddressTransactions(address);
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

    $("#send_message").on("click", function () {
        var message = $("#message").val();
        $("#message").val('');
        var to = ''
        var from = ''
        sendMessage(to,from,message)
    })

    //
    // Generate a new address
    //
    $("#genAddress").on("click", function () {

        if (!seed) {
            console.log("You did not enter your seed yet");
            return
        }

        // Deterministically generates a new address for the specified seed with a checksum
        iota.api.getNewAddress(seed, { 'checksum': true }, function (e, address) {

            if (!e) {

                address = address;
                updateAddressHTML(address);

            } else {

                console.log(e);
            }
        })
    })
});
