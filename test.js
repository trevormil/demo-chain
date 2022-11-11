var CryptoJS = require('crypto-js');
var express = require('express');
var bodyParser = require('body-parser');
var WebSocket = require('ws');

for (let i = 2; i <= 8; i++) {
    console.time('merkle generation lmt');
    let lTree = [];
    // console.log(Math.floor(10 ** 8 / 7147) * 2);
    for (let j = 0; j < Math.floor(10 ** i / 7147) * 2; j++) {
        lTree.push(CryptoJS.SHA256('DSFSDFDFS' + j * i));
    }

    console.timeEnd('merkle generation lmt');
}

console.time('merkle generation jmt');
let mTree = [];
for (let i = 0; i < 7147 * 2; i++) {
    mTree.push(CryptoJS.SHA256('DSFSDFDFS') + i);
}
console.timeEnd('merkle generation jmt');
