const express = require("express");
const { getOntology, setOntology } = require("../ontology_api");
const { serialize, tryDeserialize } = require("../ontology");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../ontology/structure').SerializedOntology} SerializedOntology */
/** @typedef {import('../sleeper').SleepCapability} SleepCapability */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../datetime').Datetime} datetime - Datetime utilities.
 * @property {SleepCapability} sleeper - A sleeper instance for delays.
 * @property {import('../generators').Interface} interface - The incremental graph interface capability.
 */

/**
 * Creates an Express router for ontology-related endpoints.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @returns {express.Router} - The configured router.
 */
function makeRouter(capabilities) {
    const router = express.Router();

    /**
     * GET /ontology - Get current ontology
     */
    router.get("/ontology", async (req, res) => {
        await handleOntologyGet(req, res, capabilities);
    });

    /**
     * PUT /ontology - Replace the entire ontology
     */
    router.put("/ontology", async (req, res) => {
        await handleOntologyPut(req, res, capabilities);
    });

    return router;
}

/**
 * Handles the GET /ontology logic.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 */
async function handleOntologyGet(_req, res, capabilities) {
    try {
        const ontology = await getOntology(capabilities);
        const serializedOntology = serialize(ontology);
        res.json({ ontology: serializedOntology });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                error: message,
                stack: error instanceof Error ? error.stack : undefined,
            },
            `Failed to fetch ontology: ${message}`
        );

        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Handles the PUT /ontology logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 */
async function handleOntologyPut(req, res, capabilities) {
    try {
        const body = req.body;

        const ontology = tryDeserialize(body);

        if (ontology instanceof Error) {
            res.status(400).json({ error: ontology.message });
            return;
        }

        const validatedOntology = validateOntologySemantics(ontology);
        if (validatedOntology instanceof Error) {
            res.status(400).json({ error: validatedOntology.message });
            return;
        }

        await setOntology(capabilities, validatedOntology);

        const serializedOntology = serialize(validatedOntology);
        res.json({ ontology: serializedOntology });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                error: message,
                stack: error instanceof Error ? error.stack : undefined,
            },
            `Failed to update ontology: ${message}`
        );

        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * @param {import('../ontology/structure').Ontology} ontology
 * @returns {import('../ontology/structure').Ontology | Error}
 */
function validateOntologySemantics(ontology) {
    /** @type {Set<string>} */
    const seenTypeNames = new Set();
    /** @type {Set<string>} */
    const seenModifierNames = new Set();

    /** @type {import('../ontology/structure').OntologyTypeEntry[]} */
    const normalizedTypes = [];
    let typeIndex = 0;
    for (const entry of ontology.types) {
        const name = entry.name.trim();
        const description = entry.description.trim();
        if (name === "") {
            return new Error(`Type at index ${typeIndex} has empty name`);
        }
        if (description === "") {
            return new Error(`Type '${name}' has empty description`);
        }
        if (seenTypeNames.has(name)) {
            return new Error(`Duplicate type name: '${name}'`);
        }
        seenTypeNames.add(name);
        normalizedTypes.push({ name, description });
        typeIndex += 1;
    }

    /** @type {import('../ontology/structure').OntologyModifierEntry[]} */
    const normalizedModifiers = [];
    let modifierIndex = 0;
    for (const entry of ontology.modifiers) {
        const name = entry.name.trim();
        const description = entry.description.trim();
        if (name === "") {
            return new Error(`Modifier at index ${modifierIndex} has empty name`);
        }
        if (description === "") {
            return new Error(`Modifier '${name}' has empty description`);
        }
        if (seenModifierNames.has(name)) {
            return new Error(`Duplicate modifier name: '${name}'`);
        }
        seenModifierNames.add(name);

        if (entry.only_for_type === undefined) {
            normalizedModifiers.push({ name, description });
            modifierIndex += 1;
            continue;
        }

        const onlyForType = entry.only_for_type.trim();
        if (onlyForType === "") {
            return new Error(`Modifier '${name}' has empty only_for_type`);
        }
        normalizedModifiers.push({ name, description, only_for_type: onlyForType });
        modifierIndex += 1;
    }

    return { types: normalizedTypes, modifiers: normalizedModifiers };
}

/**
 * @typedef {object} OntologyResponse
 * @property {SerializedOntology} ontology - The current ontology in serialized format
 */

/**
 * @typedef {object} OntologyErrorResponse
 * @property {string} error - Error message
 */

module.exports = { makeRouter };
