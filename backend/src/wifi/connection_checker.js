/**
 * @module
 * WiFi connection checking module for Termux environment.
 * Uses termux-wifi-connectioninfo to check WiFi connection status.
 */

const { termuxWifiCommand } = require("../executables");

/**
 * Error thrown when WiFi connection check fails due to system issues.
 */
class WifiCheckError extends Error {
    /**
     * @param {string} message - Error message.
     * @param {string} [stderr] - Standard error output from the command.
     */
    constructor(message, stderr) {
        super(message);
        this.name = "WifiCheckError";
        this.stderr = stderr;
    }
}

/**
 * @param {unknown} object
 * @returns {object is WifiCheckError}
 */
function isWifiCheckError(object) {
    return object instanceof WifiCheckError;
}

/**
 * Represents the WiFi connection status.
 */
class WifiConnectionStatusClass {
    /** @type {boolean} */
    connected;

    /** @type {string|null} */
    ssid;

    /** @type {string|null} */
    bssid;

    /** @type {number|null} */
    rssi;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {boolean} connected - Whether WiFi is connected.
     * @param {string|null} ssid - The SSID of the connected network.
     * @param {string|null} bssid - The BSSID of the connected network.
     * @param {number|null} rssi - The signal strength.
     */
    constructor(connected, ssid, bssid, rssi) {
        this.connected = connected;
        this.ssid = ssid;
        this.bssid = bssid;
        this.rssi = rssi;

        if (this.__brand !== undefined) {
            throw new Error("WifiConnectionStatus is a nominal type");
        }
    }
}

/**
 * @typedef {WifiConnectionStatusClass} WifiConnectionStatus
 */

/**
 * @param {unknown} object
 * @returns {object is WifiConnectionStatus}
 */
function isWifiConnectionStatus(object) {
    return object instanceof WifiConnectionStatusClass;
}

/**
 * Creates a WiFi connection status for when not connected.
 * @returns {WifiConnectionStatus}
 */
function makeDisconnectedStatus() {
    return new WifiConnectionStatusClass(false, null, null, null);
}

/**
 * Creates a WiFi connection status for when connected.
 * @param {string} ssid - The SSID of the connected network.
 * @param {string} bssid - The BSSID of the connected network.
 * @param {number} rssi - The signal strength.
 * @returns {WifiConnectionStatus}
 */
function makeConnectedStatus(ssid, bssid, rssi) {
    return new WifiConnectionStatusClass(true, ssid, bssid, rssi);
}

/**
 * Parses the JSON output from termux-wifi-connectioninfo.
 * @param {string} jsonOutput - The JSON output from the command.
 * @returns {WifiConnectionStatus}
 */
function parseWifiConnectionInfo(jsonOutput) {
    try {
        const data = JSON.parse(jsonOutput);

        // Check if we have the expected structure and bssid is not null
        if (data && typeof data === 'object' && 'bssid' in data && data.bssid !== null) {
            const ssid = data.ssid || null;
            const bssid = data.bssid;
            const rssi = typeof data.rssi === 'number' ? data.rssi : null;

            return makeConnectedStatus(ssid, bssid, rssi);
        }

        // If bssid is null or missing, we're not connected
        return makeDisconnectedStatus();
    } catch (error) {
        // If JSON parsing fails, assume disconnected
        return makeDisconnectedStatus();
    }
}

/**
 * WiFi connection checker class.
 */
class WifiConnectionCheckerClass {
    /** @type {import('../subprocess/command').Command} */
    termuxWifiCommand;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {import('../subprocess/command').Command} termuxWifiCommand - The termux-wifi-connectioninfo command.
     */
    constructor(termuxWifiCommand) {
        this.termuxWifiCommand = termuxWifiCommand;

        if (this.__brand !== undefined) {
            throw new Error("WifiConnectionChecker is a nominal type");
        }
    }

    /**
     * Checks the current WiFi connection status.
     * @returns {Promise<WifiConnectionStatus>}
     * @throws {WifiCheckError} - If the check fails due to system issues.
     */
    async checkConnection() {
        try {
            const result = await this.termuxWifiCommand.call();
            // Parse the JSON output to determine connection status
            return parseWifiConnectionInfo(result.stdout);
        } catch (error) {
            // Any error is a system issue
            const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
            const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
            throw new WifiCheckError(
                `Failed to check WiFi connection: ${message}`,
                stderr
            );
        }
    }

    /**
     * Ensures the termux-wifi-connectioninfo command is available.
     * @returns {Promise<void>}
     * @throws {import('../subprocess/resolve_executable_path').CommandUnavailable} - If the command is not available.
     */
    async ensureAvailable() {
        await this.termuxWifiCommand.ensureAvailable();
    }
}

/**
 * @typedef {WifiConnectionCheckerClass} WifiConnectionChecker
 */

/**
 * @param {unknown} object
 * @returns {object is WifiConnectionChecker}
 */
function isWifiConnectionChecker(object) {
    return object instanceof WifiConnectionCheckerClass;
}

/**
 * Creates a WiFi connection checker instance.
 * @returns {WifiConnectionChecker}
 */
function makeWifiConnectionChecker() {
    return new WifiConnectionCheckerClass(termuxWifiCommand);
}

module.exports = {
    makeWifiConnectionChecker,
    isWifiConnectionChecker,
    isWifiConnectionStatus,
    isWifiCheckError,
    makeConnectedStatus,
    makeDisconnectedStatus,
};
