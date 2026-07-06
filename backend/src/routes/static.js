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
 * @param {string} [rootPath] - Optional root path for sendFile. Defaults to module-level staticPath.
 */
function handleStaticFallback(_capabilities, _req, res, rootPath) {
    res.sendFile("index.html", {
        root: rootPath || staticPath,
        dotfiles: "allow",
    });
}

/**
 * Serves the static fallback for GET requests, or passes through for other methods.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {string} [rootPath] - Optional root path. Defaults to module-level staticPath.
 */
function serveFallbackForGet(capabilities, req, res, next, rootPath) {
    if (req.method !== "GET") {
        next();
        return;
    }

    handleStaticFallback(capabilities, req, res, rootPath);
}

/**
 * @param {Capabilities} capabilities
 * @param {string} [staticRoot] - Optional static root path. Defaults to the module-level staticPath.
 * @returns {import('express').Router}
 */
function makeRouter(capabilities, staticRoot) {
    const root = staticRoot || staticPath;
    const router = express.Router();

    router.use(express.static(root, { fallthrough: true }));

    router.use(/** @param {Error & {status?: number, statusCode?: number}} err @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next */ (err, req, res, next) => {
        if (err.status !== 404 && err.statusCode !== 404) {
            next(err);
            return;
        }

        serveFallbackForGet(capabilities, req, res, next, root);
    });

    router.use((req, res, next) => {
        serveFallbackForGet(capabilities, req, res, next, root);
    });

    return router;
}

module.exports = { makeRouter };
