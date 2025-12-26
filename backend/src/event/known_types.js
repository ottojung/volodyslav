
const registrationType = 'reg';
const textType = 'text';

const knownTypes = [registrationType, textType];

/**
 * Checks if the given event type is context-enhancing.
 * Meaning it can be used to build the context of other entries.
 *
 * @param {string} type
 * @returns {boolean}
 */
function isContextEnhancing(type) {
    return type === registrationType || type === textType;
}

module.exports = {
    knownTypes,
    isContextEnhancing,
};
