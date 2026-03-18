const HOSTNAME_PATTERN = /^[0-9A-Za-z_-]+$/;
const REMOTE_HOST_BRANCH_PATTERN = /^origin\/([0-9A-Za-z_-]+)-main$/;
const HEADS_REF_HOST_BRANCH_PATTERN = /^refs\/heads\/([0-9A-Za-z_-]+)-main$/;

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isValidHostname(hostname) {
    return HOSTNAME_PATTERN.test(hostname);
}

/**
 * @param {string} refName
 * @returns {string | null}
 */
function parseRemoteHostnameBranch(refName) {
    const match = REMOTE_HOST_BRANCH_PATTERN.exec(refName);
    if (match === null) {
        return null;
    }
    return match[1] ?? null;
}

/**
 * @param {string} refName - A full heads ref like `refs/heads/<hostname>-main` (from ls-remote output)
 * @returns {string | null}
 */
function parseHeadsRefHostnameBranch(refName) {
    const match = HEADS_REF_HOST_BRANCH_PATTERN.exec(refName);
    if (match === null) {
        return null;
    }
    return match[1] ?? null;
}

module.exports = {
    isValidHostname,
    parseRemoteHostnameBranch,
    parseHeadsRefHostnameBranch,
};
