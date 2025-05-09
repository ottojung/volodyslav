const express = require("express");
const logger = require("./logger");
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
 * @param {express.Express} app 
 * @param {() => Promise<void>} fun 
 * @returns {void}
 */
function run(app, fun) {
    app.listen(port, async () => {
        logger.info({ port }, "Server is running");
        await fun();
    });
}

module.exports = {
    make,
    run,
}
