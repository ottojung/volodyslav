/**
 * Tests for WiFi connection parsing behavior in checker.
 */

describe("WiFi connection checker parsing", () => {
    test("treats empty-string bssid as disconnected", async () => {
        jest.resetModules();
        jest.doMock("../src/executables", () => ({
            termuxWifiCommand: {
                call: async () => ({
                    stdout: JSON.stringify({
                        ssid: "TestNet",
                        bssid: "",
                        rssi: -50,
                    }),
                }),
                ensureAvailable: async () => {},
            },
        }));

        const { makeWifiConnectionChecker } = require("../src/wifi/connection_checker");
        const checker = makeWifiConnectionChecker();

        const result = await checker.checkConnection();

        expect(result.connected).toBe(false);
        expect(result.bssid).toBeNull();
    });

    test("keeps connected when bssid is non-empty string", async () => {
        jest.resetModules();
        jest.doMock("../src/executables", () => ({
            termuxWifiCommand: {
                call: async () => ({
                    stdout: JSON.stringify({
                        ssid: "TestNet",
                        bssid: "aa:bb:cc:dd:ee:ff",
                        rssi: -50,
                    }),
                }),
                ensureAvailable: async () => {},
            },
        }));

        const { makeWifiConnectionChecker } = require("../src/wifi/connection_checker");
        const checker = makeWifiConnectionChecker();

        const result = await checker.checkConnection();

        expect(result.connected).toBe(true);
        expect(result.bssid).toBe("aa:bb:cc:dd:ee:ff");
    });
});
