/**
 * Migration helpers for converting old GraphNode/Schema to new NodeDef format.
 */

/** @typedef {import('./types').GraphNode} GraphNode */
/** @typedef {import('./types').Schema} Schema */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').ConstValue} ConstValue */

/**
 * Converts an old GraphNode to a NodeDef.
 * GraphNodes are exact nodes with no variables, so the computor doesn't need bindings.
 * @param {GraphNode} graphNode
 * @returns {NodeDef}
 */
function graphNodeToNodeDef(graphNode) {
    return {
        output: graphNode.output,
        inputs: graphNode.inputs,
        computor: (inputs, oldValue, _bindings) => {
            // GraphNode computor doesn't expect bindings
            return graphNode.computor(inputs, oldValue);
        },
    };
}

/**
 * Converts an old Schema to a NodeDef.
 * The schema's computor expects string bindings, but NodeDef expects typed ConstValue bindings.
 * We convert ConstValue bindings to strings for compatibility.
 * @param {Schema} schema
 * @returns {NodeDef}
 */
function schemaToNodeDef(schema) {
    return {
        output: schema.output,
        inputs: schema.inputs,
        computor: (inputs, oldValue, bindings) => {
            // Convert typed bindings to string bindings for old schema computor
            /** @type {Record<string, string>} */
            const stringBindings = {};
            
            for (const [varName, constValue] of Object.entries(bindings)) {
                if (constValue.kind === "string") {
                    stringBindings[varName] = constValue.value;
                } else if (constValue.kind === "nat") {
                    stringBindings[varName] = String(constValue.value);
                }
            }
            
            return schema.computor(inputs, oldValue, stringBindings);
        },
    };
}

module.exports = {
    graphNodeToNodeDef,
    schemaToNodeDef,
};
