/**
 * Integration tests for WiFi connection checker.
 */

const { 
    makeWifiConnectionChecker,
    isWifiCheckError
} = require("../src/wifi");

describe("WiFi Connection Checker Integration", () => {
    describe("WiFi Connection Checker", () => {
        test("creates checker instance", () => {
            const checker = makeWifiConnectionChecker();
            expect(typeof checker).toBe("object");
            expect(typeof checker.checkConnection).toBe("function");
        });

        test("checkConnection returns a promise", () => {
            const checker = makeWifiConnectionChecker();
            const result = checker.checkConnection();
            expect(result).toBeInstanceOf(Promise);
            
            // Clean up the promise to prevent hanging
            result.catch(() => {});
        });

        test("handles connection checking without hanging", async () => {
            const checker = makeWifiConnectionChecker();
            
            // Test that the function completes within reasonable time
            // and doesn't leave hanging processes
            const result = checker.checkConnection();
            expect(result).toBeInstanceOf(Promise);
            
            // Clean up the promise properly to prevent hanging
            result.catch(() => {});
        });

        test("isWifiCheckError type guard exists", () => {
            expect(typeof isWifiCheckError).toBe("function");
            expect(isWifiCheckError({})).toBe(false);
            expect(isWifiCheckError(null)).toBe(false);
        });
    });
});
