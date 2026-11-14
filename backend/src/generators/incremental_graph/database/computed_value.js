/**
 * Runtime validation of the `ComputedValue` union.
 *
 * The union and its eighteen member typedefs are declared in `./types.js`. This
 * module is the executable form of that declaration: one closed shape per union
 * member, keyed by the member's `type` discriminant. The discriminant set is
 * derived from these shapes, so a tag can never exist without the member shape
 * behind it and a member shape can never exist without its tag.
 *
 * A shape declares every representation of its member which the repository
 * produces, because the record layer is handed a member in two of them: the live
 * value a computor returned, and the value parsed back out of the persisted text
 * of a record being replayed. Declaring one representation of a nominal member,
 * or of a member whose declared type admits `undefined`, would reject half of the
 * values the repository itself produces.
 *
 * A value event's payload must be a current-version `ComputedValue`, so this is
 * the check the record layer applies at its boundary. Nothing downstream of the
 * record layer re-validates a payload, which means a payload that reaches the
 * graph is consumed as the real value it claims to be; a payload whose inner
 * member does not match its declared union member is therefore a silently wrong
 * value rather than a rejected one.
 */

/** @typedef {import('./types').ComputedValue} ComputedValue */

const { DateTime } = require("luxon");
const { isEventId } = require("../../../event").id;
const { isDateTime } = require("../../../datetime");

/** @typedef {import("./shape").Shape} Shape */

const {
    arrayOfShape,
    closedObjectShape,
    constantShape,
    isPlainRecord,
    nullableShape,
    numberShape,
    oneOfShape,
    stringOrUndefinedShape,
    stringRecordShape,
    stringShape,
} = require("./shape");

/**
 * The shape of a member which is a nominal value of a declared class. The
 * `instanceof` check is what makes the value the nominal type the typedef names;
 * the closed object check behind it states the members that type declares, so a
 * member which is not one of them is still rejected rather than carried.
 * @param {(value: unknown) => boolean} isInstance
 * @param {string} label
 * @param {Shape} [members]
 * @returns {Shape}
 */
function nominalShape(isInstance, label, members) {
    return (value, path) => {
        if (!isInstance(value)) {
            return `${path} must be ${label}`;
        }
        return members === undefined ? undefined : members(value, path);
    };
}

/** @type {Shape} */
function luxonDateTimeShape(value, path) {
    return DateTime.isDateTime(value) ? undefined : `${path} must be a Luxon date and time`;
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
 * An `EventId` in the two representations the record layer is handed. The live
 * value is the nominal `EventId` its typedef names, carrying `identifier` and the
 * brand member which makes the type nominal. The persisted value is what
 * `JSON.stringify` writes for it, which is the `identifier` alone: the brand
 * member's value is `undefined`, so no member is written for it.
 */
const EVENT_ID = oneOfShape([
    nominalShape(
        isEventId,
        "an EventId",
        closedObjectShape({
            identifier: stringShape,
            __brand: constantShape(undefined),
        })
    ),
    closedObjectShape({ identifier: stringShape }),
]);

/**
 * A `DateTime` in the two representations the record layer is handed, for the
 * same reason as `EVENT_ID`: live it is the nominal `DateTime` wrapping a Luxon
 * date and time, and persisted it is the one ISO instant string that Luxon
 * writes for that wrapper.
 */
const DATE_TIME = oneOfShape([
    nominalShape(
        isDateTime,
        "a DateTime",
        closedObjectShape({
            __brand: constantShape(undefined),
            _luxonDateTime: luxonDateTimeShape,
        })
    ),
    closedObjectShape({ _luxonDateTime: stringShape }),
]);

/**
 * A live `Event` as it stands inside a computed value: its identifier and its
 * date are the nominal objects the `Event` typedef at `../../../event/structure`
 * declares, so a computor which returns a deserialized event is inside its
 * rights, and the persisted form of the same event is accepted beside it because
 * the record layer is handed that form too when it replays persisted text.
 */
const EVENT = closedObjectShape({
    id: EVENT_ID,
    date: DATE_TIME,
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
        { description: stringOrUndefinedShape }
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
 * The record layer is handed a payload in two representations of one declared
 * value: the live value a computor returned, and the value parsed back out of a
 * persisted record when that record is replayed. A shape therefore declares every
 * representation of a member which the repository actually produces, and still
 * rejects everything else.
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
