const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTemporary() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'jest-'));
}

let tmpDir = makeTemporary();

function input() {
    return path.join(tmpDir, 'input');
}

function output() {
    return path.join(tmpDir, 'output');
}

function beforeEach() {
    tmpDir = makeTemporary();
}

function afterEach() {
}

module.exports = {
    input,
    output,
    makeTemporary,
    beforeEach,
    afterEach,
};
