# WiFi Connection Checker Module

This module provides WiFi connection checking capabilities for Termux environments using the `termux-wifi-connectioninfo` command.

## Features

- **Non-blocking WiFi Status Check**: Checks WiFi connection status without blocking the application
- **Termux Integration**: Uses `termux-wifi-connectioninfo` command for reliable WiFi status detection
- **Graceful Error Handling**: Handles the expected exit code 1 (no WiFi) without throwing exceptions
- **Capabilities Pattern**: Integrates with the project's capabilities system for consistent dependency injection
- **Encapsulation**: Follows the project's encapsulation patterns with factory functions and type guards

## Usage

### Basic Usage with Capabilities

```javascript
const capabilities = require('./capabilities/root').make();

// Check if WiFi is connected
const status = await capabilities.wifiChecker.checkConnection();

if (status.connected) {
    console.log(`Connected to: ${status.ssid}`);
    console.log(`Signal strength: ${status.rssi} dBm`);
} else {
    console.log("WiFi is not connected");
}
```

### Direct Module Usage

```javascript
const { makeWifiConnectionChecker } = require('./wifi');

// Create a WiFi checker instance
const wifiChecker = makeWifiConnectionChecker();

// Ensure the termux-wifi-connectioninfo command is available
await wifiChecker.ensureAvailable();

// Check connection status
const status = await wifiChecker.checkConnection();
```

### Example Functions

The module includes example usage functions in `wifi_usage_examples.js`:

- `logWifiConnectionStatus(capabilities)` - Logs current WiFi status
- `isWifiConnected(capabilities)` - Returns boolean for connection status
- `waitForWifiConnection(capabilities, timeoutMs)` - Waits for WiFi connection

```javascript
const { logWifiConnectionStatus, isWifiConnected } = require('./wifi_usage_examples');

// Log current status
await logWifiConnectionStatus(capabilities);

// Check if connected
const connected = await isWifiConnected(capabilities);
```

## API Reference

### WifiConnectionChecker

Main class for checking WiFi connection status.

#### Methods

- `checkConnection()` - Returns a `Promise<WifiConnectionStatus>`
- `ensureAvailable()` - Ensures the termux-wifi-connectioninfo command is available

### WifiConnectionStatus

Represents the current WiFi connection status.

#### Properties

- `connected: boolean` - Whether WiFi is connected
- `ssid: string|null` - The SSID of the connected network (if connected)
- `bssid: string|null` - The BSSID of the connected network (if connected)
- `rssi: number|null` - The signal strength in dBm (if connected)

### Factory Functions

- `makeWifiConnectionChecker()` - Creates a WiFi connection checker instance
- `makeConnectedStatus(ssid, bssid, rssi)` - Creates a connected status object
- `makeDisconnectedStatus()` - Creates a disconnected status object

### Type Guards

- `isWifiConnectionChecker(object)` - Checks if object is a WiFi connection checker
- `isWifiConnectionStatus(object)` - Checks if object is a WiFi connection status
- `isWifiCheckError(object)` - Checks if object is a WiFi check error

## Error Handling

The module handles several error conditions:

1. **Command Not Available**: If `termux-wifi-connectioninfo` is not installed
2. **No WiFi Connection**: When `bssid` is `null` in the JSON response (handled gracefully)
3. **System Errors**: Command execution failures indicate system issues

```javascript
try {
    const status = await wifiChecker.checkConnection();
    // Handle status
} catch (error) {
    if (error.name === "CommandUnavailable") {
        console.log("termux-wifi-connectioninfo not available");
    } else if (error.name === "WifiCheckError") {
        console.log("System error checking WiFi:", error.message);
    }
}
```

## Installation Requirements

This module requires the Termux environment with the `termux-wifi-connectioninfo` command available:

```bash
# In Termux
pkg install termux-api
```

## Testing

The module includes comprehensive tests:

```bash
# Run all WiFi tests
npm test -- --testPathPattern="wifi"

# Run specific test files
npm test -- --testPathPattern="wifi.test.js"
npm test -- --testPathPattern="wifi.integration.test.js"
npm test -- --testPathPattern="wifi.capabilities.test.js"
```

## Implementation Details

### Connection Status Detection

The `termux-wifi-connectioninfo` command returns a JSON object with WiFi information. The connection status is determined by checking the `bssid` field:

- **Connected**: `bssid` is not `null`
- **Disconnected**: `bssid` is `null`

```javascript
try {
    const result = await this.termuxWifiCommand.call();
    return parseWifiConnectionInfo(result.stdout);
} catch (error) {
    // Command execution failures are system issues
    throw new WifiCheckError(error.message, error.stderr);
}
```

### JSON Parsing

The module parses the JSON output from `termux-wifi-connectioninfo` and extracts relevant information:

```javascript
// Connected example:
{
    "ssid": "MyWiFi",
    "bssid": "aa:bb:cc:dd:ee:ff",
    "rssi": -45
}

// Disconnected example:
{
    "ssid": null,
    "bssid": null,
    "rssi": null
}
```

### Capabilities Integration

The WiFi checker is automatically available through the capabilities system:

```javascript
// In capabilities/root.js
const wifiCapability = require("../wifi");

const ret = {
    // ... other capabilities
    wifiChecker: wifiCapability.makeWifiConnectionChecker(),
};
```
