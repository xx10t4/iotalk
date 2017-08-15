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

// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.
var path = require('path');

window.appRoot = path.resolve(path.join(__dirname,'../'));

window.$ = window.jQuery = require('jquery');
require("./index.js");
require("bootstrap")
