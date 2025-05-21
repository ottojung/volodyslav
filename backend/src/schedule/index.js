const { setup } = require("./runner");

/** @typedef {ReturnType<make>} Scheduler */

function make() {
    return {
        setup,
    };
}

module.exports = {
    make,
};
