const express = require("express");
const { myServerPort } = require("./environment");
const { gentleWrap } = require("./gentlewrap");
const userErrors = require("./user_errors");

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
 * @param {express.Express} app
 * @param {(app: express.Express, server: Server) => Promise<void>} fun
 * @returns {Promise<Server>}
 */
async function run(app, fun) {
    const port = myServerPort();
    const server = app.listen(port, async function () {
        try {
            const gentleFun = gentleWrap(async () => fun(app, server), userErrors);
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
