const generators = require("./generators");

const capabilities = require("./capabilities");

module.exports = {
    makeInterface: generators.makeInterface,
    DATABASE_SUBPATH: generators.DATABASE_SUBPATH,
    makeRootCapabilities: capabilities.make,
};
