const uniqueSymbol = require("../src/unique_symbol");

const capabilities = {
    seed: {
        generate: () => 42,
    },
};

describe("UniqueSymbol", () => {
    describe("makeRandom", () => {
        test("creates a UniqueSymbol with random string value", () => {
            const symbol = uniqueSymbol.makeRandom(capabilities);
            expect(uniqueSymbol.isUniqueSymbol(symbol)).toBe(true);
            expect(typeof symbol.value).toBe("string");
            expect(symbol.value).toHaveLength(16); // default length
        });

        test("creates a UniqueSymbol with custom length", () => {
            const symbol = uniqueSymbol.makeRandom(capabilities, 32);
            expect(uniqueSymbol.isUniqueSymbol(symbol)).toBe(true);
            expect(symbol.value).toHaveLength(32);
        });

        test("generated values are alphanumeric", () => {
            const symbol = uniqueSymbol.makeRandom(capabilities);
            expect(/^[0-9a-z]+$/.test(symbol.value)).toBe(true);
        });
    });

    describe("fromString", () => {
        test("creates a UniqueSymbol from a string", () => {
            const value = "test-symbol";
            const symbol = uniqueSymbol.fromString(value);
            expect(uniqueSymbol.isUniqueSymbol(symbol)).toBe(true);
            expect(symbol.value).toBe(value);
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
            const original = uniqueSymbol.fromString("prefix");
            const concatenated = original.concat("-suffix");
            
            expect(uniqueSymbol.isUniqueSymbol(concatenated)).toBe(true);
            expect(concatenated.value).toBe("prefix-suffix");
            expect(concatenated).not.toBe(original); // should be a new instance
        });

        test("original symbol remains unchanged after concatenation", () => {
            const original = uniqueSymbol.fromString("original");
            const concatenated = original.concat("-new");
            
            expect(original.value).toBe("original");
            expect(concatenated.value).toBe("original-new");
        });

        test("can concatenate empty string", () => {
            const original = uniqueSymbol.fromString("test");
            const concatenated = original.concat("");
            
            expect(concatenated.value).toBe("test");
        });

        test("throws error when concatenating with non-string", () => {
            const symbol = uniqueSymbol.fromString("test");
            expect(() => symbol.concat(123)).toThrow(TypeError);
            expect(() => symbol.concat(null)).toThrow(TypeError);
            expect(() => symbol.concat(undefined)).toThrow(TypeError);
        });

        test("supports multiple concatenations", () => {
            const symbol = uniqueSymbol.fromString("base");
            const result = symbol.concat("-part1").concat("-part2").concat("-part3");
            
            expect(result.value).toBe("base-part1-part2-part3");
        });
    });

    describe("toString", () => {
        test("returns the string value", () => {
            const symbol = uniqueSymbol.fromString("test-value");
            expect(symbol.toString()).toBe("test-value");
        });

        test("toString works with random symbols", () => {
            const symbol = uniqueSymbol.makeRandom(capabilities);
            expect(typeof symbol.toString()).toBe("string");
            expect(symbol.toString()).toBe(symbol.value);
        });
    });

    describe("isUniqueSymbol", () => {
        test("returns true for UniqueSymbol instances", () => {
            const symbol = uniqueSymbol.fromString("test");
            expect(uniqueSymbol.isUniqueSymbol(symbol)).toBe(true);
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
            const symbol = uniqueSymbol.fromString("test");
            expect(symbol.__brand).toBe(undefined);
        });

        test("different symbols with same value are equal in value but different instances", () => {
            const symbol1 = uniqueSymbol.fromString("same-value");
            const symbol2 = uniqueSymbol.fromString("same-value");
            
            expect(symbol1.value).toBe(symbol2.value);
            expect(symbol1).not.toBe(symbol2);
            expect(uniqueSymbol.isUniqueSymbol(symbol1)).toBe(true);
            expect(uniqueSymbol.isUniqueSymbol(symbol2)).toBe(true);
        });
    });
});

describe("UniqueSymbol integration with sleeper.withMutex", () => {
    const sleeper = require("../src/sleeper").make();
    
    test("withMutex accepts UniqueSymbol as mutex name", async () => {
        const symbol = uniqueSymbol.fromString("test-mutex");
        let executed = false;
        
        await sleeper.withMutex(symbol, async () => {
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
        const symbol = uniqueSymbol.fromString("mutex-name");
        const results = [];
        
        // Start two concurrent operations with different mutex types but same string value
        const promise1 = sleeper.withMutex(symbol, async () => {
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
    
    test("periodic accepts UniqueSymbol as thread name", () => {
        const symbol = uniqueSymbol.fromString("test-thread");
        let callCount = 0;
        
        const thread = threading.periodic(symbol, 100, async () => {
            callCount++;
        });
        
        expect(thread.name).toBe("test-thread");
        expect(typeof thread.start).toBe("function");
        expect(typeof thread.stop).toBe("function");
    });
    
    test("periodic still accepts regular strings", () => {
        let callCount = 0;
        
        const thread = threading.periodic("string-thread", 100, async () => {
            callCount++;
        });
        
        expect(thread.name).toBe("string-thread");
        expect(typeof thread.start).toBe("function");
        expect(typeof thread.stop).toBe("function");
    });
    
    test("concatenated UniqueSymbol works as thread name", () => {
        const baseSymbol = uniqueSymbol.fromString("base");
        const fullSymbol = baseSymbol.concat("-worker");
        
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