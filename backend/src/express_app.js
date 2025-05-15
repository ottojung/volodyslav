const express = require("express");
const { myServerPort } = require("./environment");

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
            await fun(app, server);
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
