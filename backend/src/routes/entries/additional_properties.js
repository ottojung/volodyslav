/**
 * Handler for GET /entries/:id/additional-properties
 *
 * Triggers the incremental graph to pull calories(e) for the given entry id
 * and returns any non-zero additional properties.
 */

/** @typedef {import('../../request_identifier').RequestIdentifier} RequestIdentifier */
/** @typedef {import('../../logger').Logger} Logger */
/** @typedef {import('../../generators').Interface} Interface */

/**
 * @typedef {object} Capabilities
 * @property {Logger} logger - A logger instance.
 * @property {Interface} interface - The incremental graph interface capability.
 */

/**
 * @typedef {object} AdditionalProperties
 * @property {number} [calories] - Estimated calorie count; omitted when 0 or unknown.
 */

/**
 * Handles the GET /entries/:id/additional-properties logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 * @param {RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function handleAdditionalProperties(req, res, capabilities, reqId) {
    const { id } = req.params;

    if (typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "Invalid entry id" });
        return;
    }

    const graph = capabilities.interface.incrementalGraph;
    if (graph === null) {
        capabilities.logger.logError(
            { request_identifier: reqId.identifier, entry_id: id },
            "additional-properties: incremental graph is not initialized",
        );
        res.status(503).json({ error: "Graph not initialized" });
        return;
    }

    try {
        const caloriesEntry = await graph.pull("calories", [id]);

        capabilities.logger.logDebug(
            {
                request_identifier: reqId.identifier,
                entry_id: id,
                calories_entry: caloriesEntry,
            },
            "Pulled calories entry for additional properties",
        );

        /** @type {AdditionalProperties} */
        const properties = {};

        if (
            caloriesEntry &&
            caloriesEntry.type === "calories" &&
            caloriesEntry.value > 0
        ) {
            properties.calories = caloriesEntry.value;
        }

        res.json(properties);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: message,
                error_name: error instanceof Error ? error.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
                entry_id: id,
                client_ip: req.ip,
            },
            `Failed to compute additional properties for entry ${id}: ${message}`,
        );

        res.status(500).json({ error: "Internal server error" });
    }
}

module.exports = { handleAdditionalProperties };
