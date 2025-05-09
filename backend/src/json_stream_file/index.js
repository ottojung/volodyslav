
const fs = require('fs');
const { parser } = require('stream-json');
const { streamValues } = require('stream-json/streamers/StreamValues');

// create a readable stream
const rs = fs.createReadStream('myfile.json', { encoding: 'utf8' });

// parser({ jsonStreaming: true }) allows multiple top-level values
const pipeline = rs
  .pipe(parser({ jsonStreaming: true }))
  .pipe(streamValues());

