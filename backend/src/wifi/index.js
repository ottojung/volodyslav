/**
 * WiFi module for Termux environment.
 * Provides WiFi connection checking capabilities.
 */

/**
 * @typedef {import('./connection_checker').WifiConnectionChecker} WifiConnectionChecker
 */

const {
    makeWifiConnectionChecker,
    isWifiConnectionChecker,
    isWifiConnectionStatus,
    isWifiCheckError,
    makeConnectedStatus,
    makeDisconnectedStatus,
} = require("./connection_checker");

module.exports = {
    makeWifiConnectionChecker,
    isWifiConnectionChecker,
    isWifiConnectionStatus,
    isWifiCheckError,
    makeConnectedStatus,
    makeDisconnectedStatus,
};
