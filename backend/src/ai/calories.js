/**
 * @module ai_calories
 *
 * Purpose:
 *   This module provides a unified abstraction for AI-powered calorie estimation,
 *   decoupling direct OpenAI API calls from application logic.
 *
 * Why this Module Exists:
 *   Direct API calls can scatter configuration and error handling throughout the codebase.
 *   Centralizing calorie estimation logic here ensures a single place to manage API
 *   interactions, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on estimating caloric content from entries.
 *   • Error Abstraction - Handles API-specific errors and provides consistent error types.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const { OpenAI } = require("openai");
const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;
const { fromInput } = require("../event");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../event').SerializedEvent} SerializedEvent */
/** @typedef {import('../ontology/structure').Ontology} Ontology */
/** @typedef {import('../ontology/structure').OntologyTypeEntry} OntologyTypeEntry */
/** @typedef {import('../ontology/structure').OntologyModifierEntry} OntologyModifierEntry */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

class AICaloriesError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AICaloriesError";
        this.cause = cause;
    }
}

/**
 * Checks if the error is an AICaloriesError.
 * @param {unknown} object - The error to check.
 * @returns {object is AICaloriesError}
 */
function isAICaloriesError(object) {
    return object instanceof AICaloriesError;
}

const CALORIES_MODEL = "gpt-5.2";

const SYSTEM_PROMPT = `You estimate calories consumed in the TARGET EVENT of a personal event log.

The user message contains:
- a "Target event" section with the single event whose calories must be estimated
- a "Basic context" section with related events that may clarify the target event
- optionally, a "User's logging conventions" section explaining how this specific log uses types and modifiers

Decision rules:
- Estimate calories only for food or drink consumed in the target event.
- Use basic context only to disambiguate the target event (for example, references like "same lunch", omitted quantities, or meal-prep notes).
- Do not add calories from context events that describe separate consumption events.
- If the target event is not about consuming food or drink, return N/A.
- Use 0 for clearly non-caloric drinks such as water, plain tea, or black coffee.
- If the target event clearly contains multiple consumed items, total them.
- When details are missing, infer a single best integer estimate from common portions.
- If "User's logging conventions" are provided, use them to interpret ambiguous entries (e.g. default portion sizes, whether full consumption is assumed, what units are used).

Respond with exactly one token:
- an integer like 540
- or N/A

No units, no prose, no JSON, no markdown.`;

/**
 * @param {SerializedEvent} targetEvent
 * @param {Array<SerializedEvent>} contextEvents
 * @returns {string}
 */
function makeCaloriesEntryText(targetEvent, contextEvents) {
    const relatedContext = contextEvents.filter((event) => event.id !== targetEvent.id);
    const relatedContextBlock = relatedContext.length === 0
        ? "- none"
        : relatedContext
            .map((event, index) => `${index + 1}. ${event.input}`)
            .join("\n");

    return [
        "Target event:",
        targetEvent.input,
        "",
        "Basic context (related events for disambiguation only):",
        relatedContextBlock,
    ].join("\n");
}

/**
 * Builds user logging conventions text for the events in this context.
 * Only includes type and modifier entries that are relevant to the event types present.
 * Returns null if there are no matching entries.
 *
 * The ontology represents how the user creates log entries — their personal conventions,
 * assumed defaults, and units. This helps the AI interpret ambiguous entries accurately.
 *
 * @param {Ontology} ontology
 * @param {Array<SerializedEvent>} contextEvents
 * @returns {string | null}
 */
function makeOntologyText(ontology, contextEvents) {
    const presentTypes = new Set(
        contextEvents.map((event) => fromInput.parseStructuredInput(event.input).type)
            .filter((typeName) => typeName !== "")
    );

    const matchingTypes = ontology.types.filter((t) => presentTypes.has(t.name));
    const matchingModifiers = ontology.modifiers.filter(
        (m) => m.only_for_type === undefined || presentTypes.has(m.only_for_type)
    );

    if (matchingTypes.length === 0 && matchingModifiers.length === 0) {
        return null;
    }

    const lines = ["User's logging conventions (how this log's types and modifiers work):"];

    if (matchingTypes.length > 0) {
        lines.push("Types:");
        for (const t of matchingTypes) {
            lines.push(`- ${t.name}: ${t.description}`);
        }
    }

    if (matchingModifiers.length > 0) {
        if (matchingTypes.length > 0) {
            lines.push("");
        }
        lines.push("Modifiers:");
        for (const m of matchingModifiers) {
            if (m.only_for_type !== undefined) {
                lines.push(`- ${m.name} (${m.only_for_type} only): ${m.description}`);
            } else {
                lines.push(`- ${m.name}: ${m.description}`);
            }
        }
    }

    return lines.join("\n");
}

/**
 * @param {SerializedEvent} targetEvent
 * @param {Array<SerializedEvent>} contextEvents
 * @returns {Array<{ role: "system" | "user", content: string }>}
 */
function makeCaloriesMessages(targetEvent, contextEvents) {
    const entry = makeCaloriesEntryText(targetEvent, contextEvents);
    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: entry },
    ];
}

/**
 * @param {SerializedEvent} targetEvent
 * @param {Array<SerializedEvent>} contextEvents
 * @param {Ontology} ontology
 * @returns {Array<{ role: "system" | "user", content: string }>}
 */
function makeCaloriesMessagesWithOntology(targetEvent, contextEvents, ontology) {
    let entry = makeCaloriesEntryText(targetEvent, contextEvents);
    const ontologyText = makeOntologyText(ontology, contextEvents);
    if (ontologyText !== null) {
        entry = entry + "\n\n" + ontologyText;
    }
    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: entry },
    ];
}

/**
 * @typedef {object} AICalories
 * @property {(targetEvent: SerializedEvent, contextEvents: Array<SerializedEvent>, ontology: Ontology) => Promise<number | 'N/A'>} estimateCalories
 */

/**
 * Estimates the number of calories in a log entry.
 * @param {function(string): OpenAI} openai - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {SerializedEvent} targetEvent - The event whose calories should be estimated.
 * @param {Array<SerializedEvent>} contextEvents - Basic-context events for disambiguation.
 * @param {Ontology} ontology - User's logging conventions for richer AI context.
 * @returns {Promise<number | 'N/A'>} - The estimated calorie count, or 'N/A' when not applicable.
 */
async function estimateCalories(openai, capabilities, targetEvent, contextEvents, ontology) {
    if (targetEvent.input.trim() === "") {
        return "N/A";
    }

    try {
        const apiKey = capabilities.environment.openaiAPIKey();
        const response = await openai(apiKey).chat.completions.create({
            model: CALORIES_MODEL,
            messages: makeCaloriesMessagesWithOntology(targetEvent, contextEvents, ontology),
        });
        const text = response.choices[0]?.message?.content?.trim() ?? "N/A";
        if (text === "N/A") {
            return "N/A";
        }
        const calories = parseInt(text, 10);
        if (isNaN(calories)) {
            throw new AICaloriesError(
                `Model returned a non-numeric response: ${JSON.stringify(text)}`,
                undefined
            );
        }
        return calories;
    } catch (error) {
        if (isAICaloriesError(error)) {
            throw error;
        }
        throw new AICaloriesError(
            `Failed to estimate calories: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }
}

/**
 * Creates an AICalories capability.
 * @param {() => Capabilities} getCapabilities - A function returning the capabilities object.
 * @returns {AICalories} - The AI calories interface.
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const openai = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        estimateCalories: (targetEvent, contextEvents, ontology) =>
            estimateCalories(openai, getCapabilitiesMemo(), targetEvent, contextEvents, ontology),
    };
}

module.exports = {
    CALORIES_MODEL,
    SYSTEM_PROMPT,
    makeCaloriesEntryText,
    makeCaloriesMessages,
    makeCaloriesMessagesWithOntology,
    makeOntologyText,
    make,
    isAICaloriesError,
};
