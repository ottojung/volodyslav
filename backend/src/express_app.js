const express = require("express");
const { gentleWrap } = require("./gentlewrap");

/** @typedef {import('./environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

/**
 * @returns {express.Express}
 */
function make() {
    return express();
}

/**
 * @typedef {import("http").Server} Server
 */

/**
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {express.Express} app
 * @param {(app: express.Express, server: Server) => Promise<void>} fun
 * @returns {Promise<Server>}
 */
async function run(capabilities, app, fun) {
    const port = capabilities.environment.myServerPort();
    const server = app.listen(port, async function () {
        try {
            const gentleFun = gentleWrap(async () => fun(app, server));
            await gentleFun();
        } catch (error) {
            server.close();
            throw error;
        }
    });
    return server;
}

module.exports = {
    make,
    run,
};
