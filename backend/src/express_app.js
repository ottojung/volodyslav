const express = require("express");
const { port } = require("./config");
const rootRouter = require("./routes/root");
const uploadRouter = require("./routes/upload");
const pingRouter = require("./routes/ping");
const staticRouter = require("./routes/static");
const transcribeRouter = require("./routes/transcribe");
const transcribeAllRouter = require("./routes/transcribe_all");

/**
 * @returns {express.Express}
 */
function make() {
    const app = express();

    // Mount upload and API routers
    app.use("/api", uploadRouter);
    app.use("/api", rootRouter);
    app.use("/api", pingRouter);
    app.use("/api", transcribeRouter);
    app.use("/api", transcribeAllRouter);
    app.use("/", staticRouter);

    return app;
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
            const server = app.listen(port, async function () {
                try {
                    await fun(app, server);
                    resolve(server);
                } catch (error) {
                    try {
                        server.close();
                    } finally {
                        true;
                    }
                    throw error;
                }
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
