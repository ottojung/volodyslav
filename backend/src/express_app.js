const express = require("express");
const { gentleWrap } = require("./gentlewrap");
const { makeServerAddressAlreadyInUseError } = require("./express_app_errors");

/** @typedef {import('./server').Capabilities} Capabilities */

/**
 * @returns {express.Express}
 */
function make() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    return app;
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
    return new Promise((resolve, reject) => {
        const server = app.listen(port);
        const runFunc = gentleWrap(capabilities, () => fun(app, server));

        // Handle address-in-use error
        server.once(
            "error",
            /** @param {NodeJS.ErrnoException} error */ (error) => {
                if (error.code === "EADDRINUSE") {
                    reject(makeServerAddressAlreadyInUseError());
                } else {
                    reject(error);
                }
            }
        );

        // Once listening, execute the provided function gently
        server.once("listening", () => {
            runFunc()
                .then(() => resolve(server))
                .catch((err) => {
                    server.close();
                    reject(err);
                });
        });
    });
}

module.exports = {
    make,
    run,
};
