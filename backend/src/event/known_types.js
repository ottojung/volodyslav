
const registrationType = 'reg';
const registerType = 'register';
const textType = 'text';
const photoType = 'photo';

const knownTypes = [registrationType, registerType, textType, photoType];

/**
 * Checks if the given event type is context-enhancing.
 * Meaning it can be used to build the context of other entries.
 *
 * @param {string} type
 * @returns {boolean}
 */
function isContextEnhancing(type) {
    return (
        type === registrationType ||
        type === registerType ||
        type === textType ||
        type === photoType
    );
}

module.exports = {
    knownTypes,
    isContextEnhancing,
};
