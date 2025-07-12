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
            if (behavior === 'connected') {
                mockCommand.call.mockResolvedValue({
                    stdout: '{"ssid":"TestWiFi","bssid":"aa:bb:cc:dd:ee:ff","rssi":-45}',
                    stderr: ''
                });
            } else if (behavior === 'disconnected') {
                mockCommand.call.mockResolvedValue({
                    stdout: '{"ssid":null,"bssid":null,"rssi":null}',
                    stderr: ''
                });
            } else if (behavior === 'error') {
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

    test("returns connected status when bssid is not null", async () => {
        const subprocess = require("../src/subprocess");
        subprocess.__setMockBehavior('connected');

        const checker = makeWifiConnectionChecker();
        const status = await checker.checkConnection();

        expect(status.connected).toBe(true);
        expect(status.ssid).toBe("TestWiFi");
        expect(status.bssid).toBe("aa:bb:cc:dd:ee:ff");
        expect(status.rssi).toBe(-45);
    });

    test("returns disconnected status when bssid is null", async () => {
        const subprocess = require("../src/subprocess");
        subprocess.__setMockBehavior('disconnected');

        const checker = makeWifiConnectionChecker();
        const status = await checker.checkConnection();

        expect(status.connected).toBe(false);
        expect(status.ssid).toBeNull();
        expect(status.bssid).toBeNull();
        expect(status.rssi).toBeNull();
    });

    test("returns disconnected status when JSON is malformed", async () => {
        const subprocess = require("../src/subprocess");

        // Directly mock the command call for this test
        const mockCommand = {
            call: jest.fn().mockResolvedValue({
                stdout: 'invalid json',
                stderr: ''
            }),
            ensureAvailable: jest.fn().mockResolvedValue(undefined),
        };

        subprocess.registerCommand.mockReturnValueOnce(mockCommand);

        const checker = makeWifiConnectionChecker();
        const status = await checker.checkConnection();

        expect(status.connected).toBe(false);
        expect(status.ssid).toBeNull();
        expect(status.bssid).toBeNull();
        expect(status.rssi).toBeNull();
    });

    test("throws WifiCheckError when command fails", async () => {
        const subprocess = require("../src/subprocess");
        subprocess.__setMockBehavior('error');

        const checker = makeWifiConnectionChecker();

        await expect(checker.checkConnection()).rejects.toThrow("Failed to check WiFi connection");
    });
});
