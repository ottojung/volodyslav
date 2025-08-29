/**
 * Test that the WiFi capability is properly integrated with the capabilities system.
 */

const capabilitiesRoot = require("../src/capabilities/root");
const { isWifiConnectionChecker } = require("../src/wifi");

describe("WiFi Capabilities Integration", () => {
    test("capabilities include WiFi connection checker", () => {
        const capabilities = capabilitiesRoot.make();

        expect(capabilities.wifiChecker).toBeDefined();
        expect(isWifiConnectionChecker(capabilities.wifiChecker)).toBe(true);
    });

    test("WiFi checker has expected methods", () => {
        const capabilities = capabilitiesRoot.make();
        const wifiChecker = capabilities.wifiChecker;

        expect(typeof wifiChecker.checkConnection).toBe("function");
        expect(typeof wifiChecker.ensureAvailable).toBe("function");
    });
});
