// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.
var path = require('path');

window.appRoot = path.resolve(__dirname);

window.$ = window.jQuery = require('jquery');
require("./js/index.js");
