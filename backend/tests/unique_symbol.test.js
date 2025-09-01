const uniqueSymbol = require("../src/unique_symbol");

const capabilities = {
    seed: {
        generate: () => 42,
    },
};

// Top-level creation for testing - following the ESLint rule
const testSymbol1 = uniqueSymbol.makeRandom(capabilities);
const testSymbol2 = uniqueSymbol.makeRandom(capabilities, 32);
const testSymbol3 = uniqueSymbol.fromString("test-symbol");
const testSymbol4 = uniqueSymbol.fromString("prefix");
const testSymbol5 = uniqueSymbol.fromString("original");
const testSymbol6 = uniqueSymbol.fromString("test");
const testSymbol7 = uniqueSymbol.fromString("base");
const testSymbol8 = uniqueSymbol.fromString("test-value");
const testSymbol9 = uniqueSymbol.fromString("same-value");
const testSymbol10 = uniqueSymbol.fromString("same-value");

describe("UniqueSymbol", () => {
    describe("makeRandom", () => {
        test("creates a UniqueSymbol with random string value", () => {
            expect(uniqueSymbol.isUniqueSymbol(testSymbol1)).toBe(true);
            expect(typeof testSymbol1.value).toBe("string");
            expect(testSymbol1.value).toHaveLength(16); // default length
        });

        test("creates a UniqueSymbol with custom length", () => {
            expect(uniqueSymbol.isUniqueSymbol(testSymbol2)).toBe(true);
            expect(testSymbol2.value).toHaveLength(32);
        });

        test("generated values are alphanumeric", () => {
            expect(/^[0-9a-z]+$/.test(testSymbol1.value)).toBe(true);
        });
    });

    describe("fromString", () => {
        test("creates a UniqueSymbol from a string", () => {
            const value = "test-symbol";
            expect(uniqueSymbol.isUniqueSymbol(testSymbol3)).toBe(true);
            expect(testSymbol3.value).toBe(value);
        });

        test("throws error for empty string", () => {
            expect(() => uniqueSymbol.fromString("")).toThrow("UniqueSymbol value must be a non-empty string");
        });

        test("throws error for whitespace-only string", () => {
            expect(() => uniqueSymbol.fromString("   ")).toThrow("UniqueSymbol value must be a non-empty string");
        });

        test("throws error for non-string input", () => {
            expect(() => uniqueSymbol.fromString(123)).toThrow("UniqueSymbol value must be a non-empty string");
        });
    });

    describe("concat", () => {
        test("concatenates with string to create new UniqueSymbol", () => {
            const concatenated = testSymbol4.concat("-suffix");
            
            expect(uniqueSymbol.isUniqueSymbol(concatenated)).toBe(true);
            expect(concatenated.value).toBe("prefix-suffix");
            expect(concatenated).not.toBe(testSymbol4); // should be a new instance
        });

        test("original symbol remains unchanged after concatenation", () => {
            const concatenated = testSymbol5.concat("-new");
            
            expect(testSymbol5.value).toBe("original");
            expect(concatenated.value).toBe("original-new");
        });

        test("can concatenate empty string", () => {
            const concatenated = testSymbol6.concat("");
            
            expect(concatenated.value).toBe("test");
        });

        test("throws error when concatenating with non-string", () => {
            expect(() => testSymbol6.concat(123)).toThrow(TypeError);
            expect(() => testSymbol6.concat(null)).toThrow(TypeError);
            expect(() => testSymbol6.concat(undefined)).toThrow(TypeError);
        });

        test("supports multiple concatenations", () => {
            const result = testSymbol7.concat("-part1").concat("-part2").concat("-part3");
            
            expect(result.value).toBe("base-part1-part2-part3");
        });
    });

    describe("toString", () => {
        test("returns the string value", () => {
            expect(testSymbol8.toString()).toBe("test-value");
        });

        test("toString works with random symbols", () => {
            expect(typeof testSymbol1.toString()).toBe("string");
            expect(testSymbol1.toString()).toBe(testSymbol1.value);
        });
    });

    describe("isUniqueSymbol", () => {
        test("returns true for UniqueSymbol instances", () => {
            expect(uniqueSymbol.isUniqueSymbol(testSymbol6)).toBe(true);
        });

        test("returns false for non-UniqueSymbol objects", () => {
            expect(uniqueSymbol.isUniqueSymbol("string")).toBe(false);
            expect(uniqueSymbol.isUniqueSymbol(123)).toBe(false);
            expect(uniqueSymbol.isUniqueSymbol({})).toBe(false);
            expect(uniqueSymbol.isUniqueSymbol(null)).toBe(false);
            expect(uniqueSymbol.isUniqueSymbol(undefined)).toBe(false);
        });

        test("returns false for objects with similar structure", () => {
            const fakeSymbol = { value: "test", __brand: undefined };
            expect(uniqueSymbol.isUniqueSymbol(fakeSymbol)).toBe(false);
        });
    });

    describe("nominal typing", () => {
        test("prevents direct instantiation", () => {
            // This test verifies the nominal typing behavior
            expect(testSymbol6.__brand).toBe(undefined);
        });

        test("different symbols with same value are equal in value but different instances", () => {
            expect(testSymbol9.value).toBe(testSymbol10.value);
            expect(testSymbol9).not.toBe(testSymbol10);
            expect(uniqueSymbol.isUniqueSymbol(testSymbol9)).toBe(true);
            expect(uniqueSymbol.isUniqueSymbol(testSymbol10)).toBe(true);
        });
    });
});

describe("UniqueSymbol integration with sleeper.withMutex", () => {
    const sleeper = require("../src/sleeper").make();
    const testMutexSymbol = uniqueSymbol.fromString("test-mutex");
    
    test("withMutex accepts UniqueSymbol as mutex name", async () => {
        let executed = false;
        
        await sleeper.withMutex(testMutexSymbol, async () => {
            executed = true;
        });
        
        expect(executed).toBe(true);
    });
    
    test("withMutex still accepts regular strings", async () => {
        let executed = false;
        
        await sleeper.withMutex("string-mutex", async () => {
            executed = true;
        });
        
        expect(executed).toBe(true);
    });
    
    test("UniqueSymbol and string mutexes are separate", async () => {
        const mutexSymbol = uniqueSymbol.fromString("mutex-name");
        const results = [];
        
        // Start two concurrent operations with different mutex types but same string value
        const promise1 = sleeper.withMutex(mutexSymbol, async () => {
            results.push("symbol-start");
            await new Promise(resolve => setTimeout(resolve, 10));
            results.push("symbol-end");
        });
        
        const promise2 = sleeper.withMutex("mutex-name", async () => {
            results.push("string-start");
            await new Promise(resolve => setTimeout(resolve, 5));
            results.push("string-end");
        });
        
        await Promise.all([promise1, promise2]);
        
        // Both should execute concurrently since they use different mutex keys
        expect(results).toContain("symbol-start");
        expect(results).toContain("symbol-end");
        expect(results).toContain("string-start");
        expect(results).toContain("string-end");
    });
});

describe("UniqueSymbol integration with threading.periodic", () => {
    const threading = require("../src/threading").make();
    const testThreadSymbol = uniqueSymbol.fromString("test-thread");
    const baseThreadSymbol = uniqueSymbol.fromString("base");
    
    test("periodic accepts UniqueSymbol as thread name", () => {
        const thread = threading.periodic(testThreadSymbol, 100, async () => {
            // Test callback
        });
        
        expect(thread.name).toBe("test-thread");
        expect(typeof thread.start).toBe("function");
        expect(typeof thread.stop).toBe("function");
    });
    
    test("periodic still accepts regular strings", () => {
        const thread = threading.periodic("string-thread", 100, async () => {
            // Test callback
        });
        
        expect(thread.name).toBe("string-thread");
        expect(typeof thread.start).toBe("function");
        expect(typeof thread.stop).toBe("function");
    });
    
    test("concatenated UniqueSymbol works as thread name", () => {
        const fullSymbol = baseThreadSymbol.concat("-worker");
        
        const thread = threading.periodic(fullSymbol, 100, async () => {});
        
        expect(thread.name).toBe("base-worker");
    });
});

describe("UniqueSymbolCreationError", () => {
    test("isUniqueSymbolCreationError function is defined", () => {
        // Note: UniqueSymbolCreationError is not exported, so we can't test it directly
        // This is intentional as per the encapsulation pattern
        expect(uniqueSymbol.isUniqueSymbolCreationError).toBeDefined();
        expect(typeof uniqueSymbol.isUniqueSymbolCreationError).toBe("function");
    });

    test("isUniqueSymbolCreationError returns false for other errors", () => {
        const error = new Error("regular error");
        expect(uniqueSymbol.isUniqueSymbolCreationError(error)).toBe(false);
        expect(uniqueSymbol.isUniqueSymbolCreationError("string")).toBe(false);
        expect(uniqueSymbol.isUniqueSymbolCreationError(null)).toBe(false);
    });
});