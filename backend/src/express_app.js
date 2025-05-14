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
    /**
     * @param {(value: Server) => void} resolve
     * @param {(reason?: unknown) => void} reject
     */
    function toResolve(resolve, reject) {
        try {
            const port = myServerPort();
            const server = app.listen(port, async function () {
                try {
                    await fun(app, server);
                } catch (error) {
                    server.close();
                    throw error;
                }
                resolve(server);
            });
        } catch (error) {
            reject(error);
        }
    }

    return new Promise(toResolve);
}

module.exports = {
    make,
    run,
};
