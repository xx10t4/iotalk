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

        console.log("sendTransfers: minWeightMagnitude" + minWeightMagnitude);
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

                    // TODO trying to get storeAndBroadcast to work!!
                    foo(attached, function (error, result) {
                        if (error) return callback(error)
                        callback(null, result);
                    })

                    iota.api.getNodeInfo(function (error, results) {

                        console.log("in ccurlInterface callback: attached:" + JSON.stringify(results));

                    })

                })
            })
        })
    }


    function foo(trytes, callback) {

        var transactions = [];

        trytes.forEach(function (trx) {
            transactions.push(iota.utils.transactionObject(trx));

        })

        transactions.sort(function (a, b) {
            a.currentIndex - b.currentIndex;
        });
        var publicKeyTrytes = ''
        addresses = []
        transactions.forEach(function (transaction, idx) {
            console.log("in foo :" + JSON.stringify(transaction))
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
        var publicKey = iota.utils.fromTrytes(publicKeyTrytes);
        console.log("publicKey " + publicKey)




        iota.api.storeAndBroadcast(trytes, function (error1, success1) {
            if (error1) return callback(error1);
            console.log("storeAndBroadcast callback success:" + JSON.stringify(success1))

            var finalTxs = [];

            trytes.forEach(function (trx) {
                finalTxs.push(iota.utils.transactionObject(trx));
            })
            return callback(null, finalTxs);
        })
    }




    var getPublicKey = function(tag, callback) {
        console.log("getPublicKey tag: "+tag)
        
        iota.api.findTransactions({ tags: [tag] }, function (error, result) {
            if (error) {
                return callback(error);
            } else if (result.length == 0) {
                // handle empty results
                return callback("no results in findTransactions callback for tag "+ tag);
            } else {
                iota.api.getTrytes(result, function (error, trytes) {
                    if (error) {
                        debug("error in getTrytes callback: ", error);
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
    }

    function getKeyUsername(publicKey) {
        return publicKey.name + '@' + getPublicKeyTag(publicKey.publicKey)
    }

    function debug(msg, object = '') {
        var html = $("#debug").html() + '<br />' + msg;
        if (object != '') {
            html += JSON.stringify(object);
        }
        $("#debug").html(html);
    }

    function createKeyPair() {
        return ntru.keyPair();
    }

    function encryptMessage(message, publicKey = '') {
        message = 'this is a longer !@#$%^&*()_+-=[]{}|\ message'
        if (publicKey == '') {
            fs.readFile('keys/ntru1.pub', { encoding: 'utf-8' }, (err, fileString) => {
                if (err) throw err;
                publicKey = new Uint8Array(fileString.split(','))
                var encoder = new codec.TextEncoder();
                var encodedMessage = encoder.encode(message);
                var encryptedMessage = ntru.encrypt(encodedMessage, publicKey);

                fs.readFile('keys/ntru1.prv', { encoding: 'utf-8' }, (err, fileString) => {
                    if (err) throw err;
                    var privateKey = new Uint8Array(fileString.split(','))
                    var decryptedMessage = ntru.decrypt(encryptedMessage, privateKey);
                    var decoder = new codec.TextDecoder();
                    var testMessage = decoder.decode(decryptedMessage);
                });


            });

        }
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

    var addContact = function(error, publicKey){
        console.log("addContact publicKey: "+publicKey)
        if (!localData.contacts) {
            localData.contacts = [];
        }
        var exists = false;
        for(var i = 0; i < localData.contacts.length ; i++){
            if(localData.contacts[0].publicKey === publicKey.publicKey){
                exists = true;
                break;
            }
        }
        if(!exists){
            localData.contacts.push(publicKey);
        }       
        saveLocalData(true);

    }

    var sendTransferResultsHandler = function(error, results) {

        showMessenger();

        if (error) {

            var html = '<div class="alert alert-danger alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>ERROR!</strong>' + error + '.</div>'
            $("#send__success").html(JSON.stringify(error));

            $("#submit").toggleClass("disabled");

            $("#send__waiting").css("display", "none");

        } else {

            debug("sendTransfer results " + results);
            var html = '<div class="alert alert-info alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Success!</strong> You have successfully sentmessage.</div>'
            $("#send__success").html(html);

        }
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

    function getLocalDataFileName() {
        return window.appRoot + "/data/" + seed.substr(0, 6) + ".json"
    }

    //
    //  Makes a new transaction
    //  Includes message and optional tag and value
    //
    function sendMessage(address, message, tag = '', value = 0) {

        try {

            var transfer = [{
                'address': address,
                'value': parseInt(value),
                'message': iota.utils.toTrytes(message),
                'tag': tag
            }]

            // We send the transfer from this seed, with depth 4 and minWeightMagnitude 18
            sendTransfers(transfer, 4, 15, function (error, results) {
                showMessenger();
                debug("sendTransfer error " + error);
                debug("WTF results " + results);

                if (error) {

                    var html = '<div class="alert alert-danger alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>ERROR!</strong>' + error + '.</div>'
                    $("#send__success").html(JSON.stringify(error));

                    $("#submit").toggleClass("disabled");

                    $("#send__waiting").css("display", "none");

                } else {

                    debug("sendTransfer results " + results);
                    var html = '<div class="alert alert-info alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Success!</strong> You have successfully sentmessage.</div>'
                    $("#send__success").html(html);



                }
            })
            $("#submit").toggleClass("disabled");
            showWaiting("Sending message. This may take a few minutes.");
        } catch (e) {

            console.log(e);
            var html = '<div class="alert alert-warning alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Wrong Format!</strong> Your message contains an illegal character. Make sure you only enter valid ASCII characters.</div>'
            $("#send__success").html(html);

        }

    }

    function sendTransactionTrytes(trytes) {
        // Broadcast and store tx
        iota.api.broadcastAndStore([trytes], function (error, success) {

            if (error) {
                $("#send__success").html(JSON.stringify(iota.utils.transactionObject(error)));
            } else {
                $("#send__success").html(JSON.stringify(iota.utils.transactionObject(trytes)));
            }
        })
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
    The first 27 trytes of a public key fingerprint. Intended for use as a tangle transaction tag to make searching for the tag easy.
    */
    function getPublicKeyTag(publicKey) {
        return createPublicKeyFinderprint(publicKey).substr(0, 27);
    }

    /*
    Creates a 81 tryte hash of a public key. Intended for use as a fingerprint of the public key
    */
    function createPublicKeyFinderprint(publicKey) {
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
    function validatePublicKey(publicKey, fingerprint) {
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

    //
    $("#submit_transaction").on("click", function () {

        // We modify the entered seed to fit the criteria of 81 chars, all uppercase and only latin letters
        var transaction = $("#transaction").val();


        // We fetch the latest transactions every 90 seconds
        sendTransactionTrytes(transaction);
    });

    $("#submit_receive_address").on("click", function () {

        var address = $("#address").val();
        retrieveAddressTransactions(address);
    });

    $("#create_key_pair").on("click", function () {
        //createKeyPair();
        encryptMessage('joe', '');
    });

    $("#add_contact").on("click", function () {
        var address = $("#contact_address").val();
        var tag = address.split('@')[1];
        $("#contact_address").val('');
        // the http request hangs unless this method is called more than once, so workaround is to just call it twice. WTF!!
        getPublicKey(tag, addContact);
        getPublicKey(tag, addContact);
    });

    $("#create_account").on("click", function () {

        if (!seed) {
            var html = '<div class="alert alert-warning alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>No Seed!</strong> You have not entered your seed yet. Do so on the Menu on the right.</div>'
            $("#send__success").html(html);
            return
        }

        var name = $("#name").val();
        $("#name").val('');
        createAccount(name)
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
