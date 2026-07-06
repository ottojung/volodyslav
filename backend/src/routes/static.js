const express = require("express");
const path = require("path");

/**
 * @typedef {object} Capabilities
 */

const staticPath = path.join(__dirname, "..", "..", "..", "frontend", "dist");

/**
 * Handles serving the index.html for all other GET requests.
 * @param {Capabilities} _capabilities - The capabilities object (unused).
 * @param {import('express').Request} _req - The Express request object (unused).
 * @param {import('express').Response} res - The Express response object.
 */
function handleStaticFallback(_capabilities, _req, res) {
    res.sendFile(path.join(staticPath, "index.html"));
}

/**
 * Serves the static fallback for GET requests, or passes through for other methods.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function serveFallbackForGet(capabilities, req, res, next) {
    if (req.method !== "GET") {
        next();
        return;
    }

    handleStaticFallback(capabilities, req, res);
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.use(express.static(staticPath, { fallthrough: true }));

    router.use(/** @param {Error & {status?: number, statusCode?: number}} err @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next */ (err, req, res, next) => {
        if (err.status !== 404 && err.statusCode !== 404) {
            next(err);
            return;
        }

        serveFallbackForGet(capabilities, req, res, next);
    });

    router.use((req, res, next) => {
        serveFallbackForGet(capabilities, req, res, next);
    });

    return router;
}

module.exports = { makeRouter };
