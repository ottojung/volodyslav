/**
 * Runtime validation of the `ComputedValue` union.
 *
 * The union and its eighteen member typedefs are declared in `./types.js`. This
 * module is the executable form of that declaration: one closed shape per union
 * member, keyed by the member's `type` discriminant. The discriminant set is
 * derived from these shapes, so a tag can never exist without the member shape
 * behind it and a member shape can never exist without its tag.
 *
 * A value event's payload must be a current-version `ComputedValue`, so this is
 * the check the record layer applies at its boundary. Nothing downstream of the
 * record layer re-validates a payload, which means a payload that reaches the
 * graph is consumed as the real value it claims to be; a payload whose inner
 * member does not match its declared union member is therefore a silently wrong
 * value rather than a rejected one.
 */

/** @typedef {import('./types').ComputedValue} ComputedValue */

/**
 * A shape check reports the first way a value fails the shape, so a rejected
 * payload can say which member of which union member was wrong.
 * @typedef {(value: unknown, path: string) => string | undefined} Shape
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const { hasOwnProperty } = Object.prototype;

/** @type {Shape} */
function stringShape(value, path) {
    return typeof value === "string" ? undefined : `${path} must be a string`;
}

/**
 * A finite number. A count or a binding which is `Infinity` is not a value the
 * current format can carry, because `JSON.stringify` never writes it.
 * @type {Shape}
 */
function numberShape(value, path) {
    if (typeof value !== "number") {
        return `${path} must be a number`;
    }
    return Number.isFinite(value) ? undefined : `${path} must be a finite number`;
}

/**
 * @param {string} expected
 * @returns {Shape}
 */
function constantShape(expected) {
    return (value, path) =>
        value === expected ? undefined : `${path} must be ${JSON.stringify(expected)}`;
}

/**
 * A closed object: every declared member must be present with its declared
 * shape, and a member which the declaration does not declare is rejected
 * instead of being carried into meaning by whichever reader happens to see it.
 * @param {Record<string, Shape>} required
 * @param {Record<string, Shape>} [optional]
 * @returns {Shape}
 */
function closedObjectShape(required, optional = {}) {
    return (value, path) => {
        if (!isPlainRecord(value)) {
            return `${path} must be an object`;
        }
        for (const [name, shape] of Object.entries(required)) {
            if (!hasOwnProperty.call(value, name)) {
                return `${path} is missing member ${JSON.stringify(name)}`;
            }
            const violation = shape(value[name], `${path}.${name}`);
            if (violation !== undefined) {
                return violation;
            }
        }
        for (const [name, member] of Object.entries(value)) {
            if (hasOwnProperty.call(required, name)) {
                continue;
            }
            const shape = hasOwnProperty.call(optional, name) ? optional[name] : undefined;
            if (shape === undefined) {
                return `${path} has unknown member ${JSON.stringify(name)}`;
            }
            const violation = shape(member, `${path}.${name}`);
            if (violation !== undefined) {
                return violation;
            }
        }
        return undefined;
    };
}

/**
 * @param {Shape} shape
 * @returns {Shape}
 */
function arrayOfShape(shape) {
    return (value, path) => {
        if (!Array.isArray(value)) {
            return `${path} must be an array`;
        }
        for (const [index, member] of value.entries()) {
            const violation = shape(member, `${path}[${index}]`);
            if (violation !== undefined) {
                return violation;
            }
        }
        return undefined;
    };
}

/**
 * @param {Shape} shape
 * @returns {Shape}
 */
function nullableShape(shape) {
    return (value, path) => (value === null ? undefined : shape(value, path));
}

/**
 * @param {ReadonlyArray<Shape>} shapes
 * @returns {Shape}
 */
function oneOfShape(shapes) {
    return (value, path) => {
        for (const shape of shapes) {
            if (shape(value, path) === undefined) {
                return undefined;
            }
        }
        return `${path} matches none of the declared shapes`;
    };
}

/**
 * @param {Shape} shape
 * @returns {Shape}
 */
function stringRecordShape(shape) {
    return (value, path) => {
        if (!isPlainRecord(value)) {
            return `${path} must be an object`;
        }
        for (const [name, member] of Object.entries(value)) {
            const violation = shape(member, `${path}.${name}`);
            if (violation !== undefined) {
                return violation;
            }
        }
        return undefined;
    };
}

const CREATOR = closedObjectShape({
    name: stringShape,
    uuid: stringShape,
    version: stringShape,
    hostname: stringShape,
});

const SERIALIZED_EVENT = closedObjectShape({
    id: stringShape,
    date: stringShape,
    original: stringShape,
    input: stringShape,
    creator: CREATOR,
});

/**
 * A live `Event` as it stands inside a computed value: its identifier is a
 * nominal object and its date is a nominal object wrapping one ISO instant, so
 * both are objects after a JSON round trip rather than strings.
 */
const EVENT = closedObjectShape({
    id: closedObjectShape({ identifier: stringShape }),
    date: closedObjectShape({ _luxonDateTime: stringShape }),
    original: stringShape,
    input: stringShape,
    creator: CREATOR,
});

const META_EVENT = closedObjectShape({
    action: constantShape("add"),
    event: EVENT,
});

const META_EVENT_DELETE = closedObjectShape({
    action: constantShape("delete"),
    event: EVENT,
});

const META_EVENT_EDIT = closedObjectShape({
    action: constantShape("edit"),
    event: EVENT,
});

const CONTEXT_ENTRY = closedObjectShape({
    eventId: stringShape,
    context: arrayOfShape(EVENT),
});

const TRANSCRIBER = closedObjectShape({
    name: stringShape,
    creator: stringShape,
});

const TRANSCRIPTION = closedObjectShape({
    text: stringShape,
    transcriber: TRANSCRIBER,
    creator: CREATOR,
});

const TRANSCRIPTION_ERROR = closedObjectShape({
    message: stringShape,
});

const TRANSCRIPTION_RESULT = oneOfShape([TRANSCRIPTION, TRANSCRIPTION_ERROR]);

const SHORTCUT = closedObjectShape(
    { pattern: stringShape, replacement: stringShape },
    { description: stringShape }
);

const CONFIG = closedObjectShape({
    help: stringShape,
    shortcuts: arrayOfShape(SHORTCUT),
});

const ONTOLOGY_TYPE_ENTRY = closedObjectShape({
    name: stringShape,
    description: stringShape,
});

const ONTOLOGY_MODIFIER_ENTRY = closedObjectShape(
    { name: stringShape, description: stringShape },
    { only_for_type: stringShape }
);

const ONTOLOGY = closedObjectShape({
    types: arrayOfShape(ONTOLOGY_TYPE_ENTRY),
    modifiers: arrayOfShape(ONTOLOGY_MODIFIER_ENTRY),
});

/**
 * The closed shape of every member of the `ComputedValue` union, keyed by that
 * member's `type` discriminant. Each shape declares exactly the members its
 * typedef at `./types.js` declares, so adding a union member without a shape and
 * adding a shape without a union member are both unrepresentable here.
 * @type {ReadonlyMap<string, Shape>}
 */
const COMPUTED_VALUE_MEMBER_SHAPES = new Map([
    ["all_events", closedObjectShape({
        type: constantShape("all_events"),
        events: arrayOfShape(SERIALIZED_EVENT),
    })],
    ["config", closedObjectShape({
        type: constantShape("config"),
        config: nullableShape(CONFIG),
    })],
    ["meta_events", closedObjectShape({
        type: constantShape("meta_events"),
        meta_events: arrayOfShape(oneOfShape([META_EVENT, META_EVENT_DELETE, META_EVENT_EDIT])),
    })],
    ["event_context", closedObjectShape({
        type: constantShape("event_context"),
        contexts: arrayOfShape(CONTEXT_ENTRY),
    })],
    ["event", closedObjectShape({
        type: constantShape("event"),
        value: SERIALIZED_EVENT,
    })],
    ["basic_context", closedObjectShape({
        type: constantShape("basic_context"),
        eventId: stringShape,
        events: arrayOfShape(SERIALIZED_EVENT),
    })],
    ["calories", closedObjectShape({
        type: constantShape("calories"),
        value: oneOfShape([numberShape, constantShape("N/A")]),
    })],
    ["transcription", closedObjectShape({
        type: constantShape("transcription"),
        value: TRANSCRIPTION_RESULT,
    })],
    ["event_transcription", closedObjectShape({
        type: constantShape("event_transcription"),
        event: EVENT,
        transcription: TRANSCRIPTION_RESULT,
    })],
    ["sorted_events_descending", closedObjectShape({
        type: constantShape("sorted_events_descending"),
        events: arrayOfShape(SERIALIZED_EVENT),
    })],
    ["sorted_events_ascending", closedObjectShape({
        type: constantShape("sorted_events_ascending"),
        events: arrayOfShape(SERIALIZED_EVENT),
    })],
    ["last_entries", closedObjectShape({
        type: constantShape("last_entries"),
        n: numberShape,
        events: arrayOfShape(SERIALIZED_EVENT),
    })],
    ["first_entries", closedObjectShape({
        type: constantShape("first_entries"),
        n: numberShape,
        events: arrayOfShape(SERIALIZED_EVENT),
    })],
    ["events_count", closedObjectShape({
        type: constantShape("events_count"),
        count: numberShape,
    })],
    ["event_audios_list", closedObjectShape({
        type: constantShape("event_audios_list"),
        event: SERIALIZED_EVENT,
        audioPaths: arrayOfShape(stringShape),
    })],
    ["entry_description", closedObjectShape(
        { type: constantShape("entry_description") },
        { description: stringShape }
    )],
    ["diary_most_important_info_summary", closedObjectShape({
        type: constantShape("diary_most_important_info_summary"),
        markdown: stringShape,
        summaryDate: stringShape,
        processedEntries: stringRecordShape(stringShape),
        updatedAt: stringShape,
        model: stringShape,
        version: stringShape,
    })],
    ["ontology", closedObjectShape({
        type: constantShape("ontology"),
        ontology: ONTOLOGY,
    })],
]);

/**
 * The `type` discriminant of every member of the `ComputedValue` union, derived
 * from the member shapes so the two cannot drift apart.
 * @type {ReadonlySet<string>}
 */
const COMPUTED_VALUE_TYPE_TAGS = new Set(COMPUTED_VALUE_MEMBER_SHAPES.keys());

/**
 * Why an untrusted value is not a current-version `ComputedValue`, or
 * `undefined` when it is one.
 *
 * `entry_description` carries a `description` which the computor leaves
 * `undefined` when an event is not a diary entry. `JSON.stringify` writes no
 * member for an `undefined` value, so the canonical persisted form of that
 * member is an absent one, and the shape declares it optional.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function computedValueViolation(value) {
    if (!isPlainRecord(value)) {
        return "payload must be an object";
    }
    const tag = value["type"];
    if (typeof tag !== "string") {
        return "payload has no string type discriminant";
    }
    const shape = COMPUTED_VALUE_MEMBER_SHAPES.get(tag);
    if (shape === undefined) {
        return "payload names no member of the current ComputedValue union: " + JSON.stringify(tag);
    }
    return shape(value, "payload");
}

/**
 * @param {unknown} value
 * @returns {value is ComputedValue}
 */
function isComputedValue(value) {
    return computedValueViolation(value) === undefined;
}

module.exports = {
    COMPUTED_VALUE_MEMBER_SHAPES,
    COMPUTED_VALUE_TYPE_TAGS,
    computedValueViolation,
    isComputedValue,
};
