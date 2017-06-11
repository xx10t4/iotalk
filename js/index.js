
$(document).ready(function() {
    const IOTA = require("iota.lib.js");

    //  Instantiate IOTA with provider 'http://localhost:14265'
    var iota = new IOTA({
        'host': 'http://iota1',
        'port': 14265
    });

    var seed;
    var balance = 0;
    var addresses = [];
    var checkedTxs = 0;

    function showLogin(message = "") {
        $("#login-message").html(message);
        if( message = ""){
            $("#login-message").addClass("hidden");
        } else {
            $("#login-message").removeClass("hidden");
        }
        $(".login_section").removeClass("hidden");
        $(".messenger_section").addClass("hidden");
        $(".waiting_section").addClass("hidden");
       
    }

    function showMessenger() {
        $(".login_section").addClass("hidden");
        $(".messenger_section").removeClass("hidden");
        $(".waiting_section").addClass("hidden");
    }

    function showWaiting(message) {
        $(".login_section").addClass("hidden");
        $(".messenger_section").addClass("hidden");
        $(".waiting_section").removeClass("hidden");
        $("#waiting-message").html(message);
    }

    function validateSeed(value){
        var result = {"valid": true, "message": ""}
        if(!value || value == ""){
            result["message"] = "Seed cannot be blank"
        }
        if(result["message"] != "") {
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
    //  Gets the addresses and transactions of an account
    //  As well as the current balance
    //  Automatically updates the HTML on the site
    //
    function getAccountInfo() {

        console.log("fetching account data...");

        // Command to be sent to the IOTA Node
        // Gets the latest transfers for the specified seed
        iota.api.getAccountData(seed, function(e, accountData) {

            if(e){
                showLogin(e);
                return;
            }

            if(!accountData){
                showLogin("Account not found");
                return;
            }

            console.log("Account data", accountData);

            addresses = []
             
            // Update address in case it's not defined yet
            accountData.addresses.forEach(function(addr) {

                addresses.push(iota.utils.addChecksum(addr));

            })

            var transferList = [];

            //  Go through all transfers to determine if the tx contains a message
            //  Only valid JSON data is accepted
            if (accountData.transfers.length > checkedTxs) {

                console.log("RECEIVED NEW TXS");

                accountData.transfers.forEach(function(transfer) {

                    try {

                        var message = iota.utils.extractJson(transfer);
                        console.log("Extracted JSON from Transaction: ", message);

                        message = JSON.parse(message);
                        console.log("JSON: ", message);

                        var newTx = {
                            'name': message.name,
                            'message': message.message,
                            'value': transfer[0].value
                        }
                        transferList.push(newTx);

                    } catch(e) {
                        console.log("Transaction did not contain any JSON Data");
                    }
                })

                checkedTxs = accountData.transfers.length;
            }

 
            balance = accountData.balance;
            showMessenger();
        })
    }


    function createAndSendMessage(toAddress, toName, message, value) {

 
        if (value > balance) {
            var html = '<div class="alert alert-warning alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Value too high!</strong> You have specified a too high value.</div>'
            $("#send__success").html(html);
            return
        }

        // the message which we will send with the transaction
        var messageJson = {
            'name': toName,
            'message': message
        }

        // Convert the user message into trytes
        // In case the user supplied non-ASCII characters we throw an error
        try {
            console.log("Sending Message: ", messageJson);
            var jsonString = JSON.stringify(messageJson) 
            console.log("jsonString: ", jsonString);
            var messageTrytes = iota.utils.toTrytes(jsonString);
            console.log("Converted Message into trytes: ", messageTrytes);
            // We display the loading screen
            $("#send__waiting").css("display", "block");
            $("#submit").toggleClass("disabled");
            // If there was any previous error message, we remove it
            $("#send__success").html();

            // call send transfer
            sendTransfer(toAddress, value, messageTrytes);

        } catch (e) {

            console.log(e);
            var html = '<div class="alert alert-warning alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Wrong Format!</strong> Your message contains an illegal character. Make sure you only enter valid ASCII characters.</div>'
            $("#send__success").html(html);

        }
    }


    //
    //  Makes a new transfer for the specified seed
    //  Includes message and value
    //
    function sendTransfer(address, value, messageTrytes) {

        var transfer = [{
            'address': address,
            'value': parseInt(value),
            'message': messageTrytes
        }]

        console.log("Sending Transfer", transfer);

        // We send the transfer from this seed, with depth 4 and minWeightMagnitude 18
        iota.api.sendTransfer(seed, 4, 18, transfer, function(e) {

            if (e){

                var html = '<div class="alert alert-danger alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>ERROR!</strong>' + e + '.</div>'
                $("#send__success").html(JSON.stringify(e));

                $("#submit").toggleClass("disabled");

                $("#send__waiting").css("display", "none");

            } else {

                var html = '<div class="alert alert-info alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>Success!</strong> You have successfully sent your transaction. If you want to make another one make sure that this transaction is confirmed first (check in your client).</div>'
                $("#send__success").html(html);

                $("#submit").toggleClass("disabled");

                $("#send__waiting").css("display", "none");

                balance = balance - value;
                updateBalanceHTML(balance);
            }
        })
    }


    function sendTransactionTrytes(trytes) {        
        // Broadcast and store tx
        iota.api.broadcastAndStore([trytes], function(error, success) {

            if (error) {
                $("#send__success").html(JSON.stringify(iota.utils.transactionObject(error)));
            } else {
                $("#send__success").html(JSON.stringify(iota.utils.transactionObject(trytes)));
            }
        })
    }

    function retrieveAddressTransactions(address) {

        var params = {"addresses":[address]}
        // Broadcast and store tx
        iota.api.findTransactionObjects(params, function(error, success) {

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


    //
    // Set seed
    //
    $("#login").on("click", function() {

 
        var seed_ = $("#userSeed").val();    

        var check = validateSeed(seed_);
        console.log("check", check); 
        if(!check["valid"]) {
            showLogin(check["message"]);
            return;
        }
        $("#login-message").addClass("hidden");
        // We modify the entered seed to fit the criteria of 81 chars, all uppercase and only latin letters
        setSeed(seed_);
 
        // We fetch the latest transactions every 90 seconds
        getAccountInfo();
        //setInterval(getAccountInfo, 90000);
        showWaiting("Retrieving account info. This may take a few minutes.");                     
    });

    //
    $("#submit_transaction").on("click", function() {

        // We modify the entered seed to fit the criteria of 81 chars, all uppercase and only latin letters
        var transaction = $("#transaction").val();

 
        // We fetch the latest transactions every 90 seconds
        sendTransactionTrytes(transaction);
    });

    $("#submit_receive_address").on("click", function() {

        var address = $("#address").val();
        retrieveAddressTransactions(address);
    });




    

     $("#submit").on("click", function() {

        setSeed($("#userSeed").val());

        // Then we remove the input
        $("#enterSeed").html('<div class="alert alert-success" role="alert">Successfully saved your seed. You can generate an address now.</div>');

        // We fetch the latest transactions every 90 seconds
        getAccountInfo();
        setInterval(getAccountInfo, 90000);

        if (!seed) {
            var html = '<div class="alert alert-warning alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>No Seed!</strong> You have not entered your seed yet. Do so on the Menu on the right.</div>'
            $("#send__success").html(html);
            return
        }

        //if (!balance || balance === 0) {
       //     var html = '<div class="alert alert-warning alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button><strong>No Tokens!</strong> You do not have enough IOTA tokens. Make sure you have enough confirmed tokens.</div>'
       //    $("#send__success").html(html);
        //    return
        //}
        seed = $("#userSeed").val();
        var name = $("#name").val();
        var value = parseInt($("#value").val());
        var address = $("#address").val();
        var message = $("#message").val();
         console.log("creating message", message);
        createAndSendMessage(address,name,message,value)      
    })
 
 
    //
    // Generate a new address
    //
    $("#genAddress").on("click", function() {

        if (!seed) {
            console.log("You did not enter your seed yet");
            return
        }

        // Deterministically generates a new address for the specified seed with a checksum
        iota.api.getNewAddress( seed, { 'checksum': true }, function( e, address ) {

            if (!e) {

                address = address;
                updateAddressHTML(address);

            } else {

                console.log(e);
            }
        })
    })
});
