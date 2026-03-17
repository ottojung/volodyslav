
const registrationType = 'reg';
const registrationAliasType = 'register';
const textType = 'text';
const photoType = 'photo';

const knownTypes = [registrationType, registrationAliasType, textType, photoType];

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
        type === registrationAliasType ||
        type === textType ||
        type === photoType
    );
}

module.exports = {
    knownTypes,
    isContextEnhancing,
};
