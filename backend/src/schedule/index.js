const { schedule } = require("./runner");

/** @typedef {ReturnType<make>} Scheduler */

function make() {
    return {
        schedule,
    };
}

module.exports = {
    make,
};
