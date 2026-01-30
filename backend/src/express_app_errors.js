/**
 * Errors related to Express application.
 */

class ServerAddressAlreadyInUseError extends Error {
    constructor() {
        super(
            "Server address is already in use. This usually means that the server is already running."
        );
    }
}

/**
 * @param {unknown} object
 * @returns {object is ServerAddressAlreadyInUseError}
 */
function isServerAddressAlreadyInUseError(object) {
    return object instanceof ServerAddressAlreadyInUseError;
}

/**
 * @returns {ServerAddressAlreadyInUseError}
 */
function makeServerAddressAlreadyInUseError() {
    return new ServerAddressAlreadyInUseError();
}

module.exports = {
    makeServerAddressAlreadyInUseError,
    isServerAddressAlreadyInUseError,
};
