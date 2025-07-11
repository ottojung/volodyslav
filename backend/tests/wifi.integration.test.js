/**
 * Integration tests for WiFi connection checker with mock subprocess behavior.
 */

const { makeWifiConnectionChecker } = require("../src/wifi");

// Mock the subprocess module to simulate different behaviors
jest.mock("../src/subprocess", () => {
    const mockCommand = {
        call: jest.fn(),
        ensureAvailable: jest.fn().mockResolvedValue(undefined),
    };

    const originalModule = jest.requireActual("../src/subprocess");

    return {
        ...originalModule,
        registerCommand: jest.fn(() => mockCommand),
        __setMockBehavior: (behavior) => {
            if (behavior === 'success') {
                mockCommand.call.mockResolvedValue({
                    stdout: '{"ssid":"TestWiFi","bssid":"aa:bb:cc:dd:ee:ff","rssi":-45}',
                    stderr: ''
                });
            } else if (behavior === 'exit1') {
                const error = new Error('Command failed: termux-wifi-connectioninfo');
                error.code = 1;
                error.stderr = '';
                error.stdout = '';
                mockCommand.call.mockRejectedValue(error);
            } else if (behavior === 'exit2') {
                const error = new Error('Command failed: termux-wifi-connectioninfo');
                error.code = 2;
                error.stderr = 'Permission denied';
                error.stdout = '';
                mockCommand.call.mockRejectedValue(error);
            }
        }
    };
});

describe("WiFi Connection Checker Integration", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("returns connected status when command succeeds", async () => {
        const subprocess = require("../src/subprocess");
        subprocess.__setMockBehavior('success');

        const checker = makeWifiConnectionChecker();
        const status = await checker.checkConnection();

        expect(status.connected).toBe(true);
        expect(status.ssid).toBe("TestWiFi");
        expect(status.bssid).toBe("aa:bb:cc:dd:ee:ff");
        expect(status.rssi).toBe(-45);
    });

    test("returns disconnected status when command exits with code 1", async () => {
        const subprocess = require("../src/subprocess");
        subprocess.__setMockBehavior('exit1');

        const checker = makeWifiConnectionChecker();
        const status = await checker.checkConnection();

        expect(status.connected).toBe(false);
        expect(status.ssid).toBeNull();
        expect(status.bssid).toBeNull();
        expect(status.rssi).toBeNull();
    });

    test("throws WifiCheckError when command fails with other exit codes", async () => {
        const subprocess = require("../src/subprocess");
        subprocess.__setMockBehavior('exit2');

        const checker = makeWifiConnectionChecker();

        await expect(checker.checkConnection()).rejects.toThrow("Failed to check WiFi connection");
    });
});
