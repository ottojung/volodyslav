/**
 * Tests for stack depth handling in dependency graph modules.
 * These tests verify that recursive functions have been replaced with iteration
 * to prevent stack overflow on deep dependency chains.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/dependency_graph/database");
const {
    makeDependencyGraph,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");
const { validateAcyclic } = require("../src/generators/dependency_graph/compiled_node");
const { compileNodeDef } = require("../src/generators/dependency_graph/compiled_node");

/**
 * @typedef {import('../src/generators/dependency_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "dependency-graph-stack-test-")
    );

    stubLogger(capabilities);

    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("dependency_graph stack depth handling", () => {
    describe("propagateOutdated with deep dependency chains", () => {
        test("handles deep linear dependency chain without stack overflow", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Create a deep chain: level0 -> level1 -> level2 -> ... -> level999
            const depth = 1000;
            const nodeDefs = [];

            // Source node
            nodeDefs.push({
                output: "level0",
                inputs: [],
                computor: (_inputs, oldValue, _bindings) => oldValue || { value: 0 },
                isDeterministic: true,
                hasSideEffects: false,
            });

            // Chain of dependent nodes
            for (let i = 1; i < depth; i++) {
                nodeDefs.push({
                    output: `level${i}`,
                    inputs: [`level${i - 1}`],
                    computor: (inputs, _oldValue, _bindings) => {
                        const input = inputs[0];
                        return { value: input.value + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                });
            }

            const graph = makeDependencyGraph(db, nodeDefs);

            // Set initial value
            await graph.set("level0", { value: 0 });

            // Pull deepest node to ensure full chain is evaluated
            const result = await graph.pull(`level${depth - 1}`);
            expect(result.value).toBe(depth - 1);

            // Update source and verify propagation works without stack overflow
            await graph.set("level0", { value: 100 });
            const updatedResult = await graph.pull(`level${depth - 1}`);
            expect(updatedResult.value).toBe(100 + depth - 1);

            await db.close();
        });

        test("handles wide fanout without stack overflow", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Create a wide fanout: one source with many dependents
            const fanoutWidth = 500;
            const nodeDefs = [];

            // Source node
            nodeDefs.push({
                output: "source",
                inputs: [],
                computor: (_inputs, oldValue, _bindings) => oldValue || { value: 0 },
                isDeterministic: true,
                hasSideEffects: false,
            });

            // Many dependent nodes
            for (let i = 0; i < fanoutWidth; i++) {
                nodeDefs.push({
                    output: `dependent${i}`,
                    inputs: ["source"],
                    computor: (inputs, _oldValue, _bindings) => {
                        const input = inputs[0];
                        return { value: input.value + i };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                });
            }

            const graph = makeDependencyGraph(db, nodeDefs);

            // Set initial value
            await graph.set("source", { value: 10 });

            // Verify all dependents computed correctly
            for (let i = 0; i < fanoutWidth; i++) {
                const result = await graph.pull(`dependent${i}`);
                expect(result.value).toBe(10 + i);
            }

            // Update source - this should propagate to all dependents without stack overflow
            await graph.set("source", { value: 20 });

            // Verify all dependents updated correctly
            for (let i = 0; i < fanoutWidth; i++) {
                const result = await graph.pull(`dependent${i}`);
                expect(result.value).toBe(20 + i);
            }

            await db.close();
        });

        test("handles deep tree structure without stack overflow", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Create a binary tree structure
            // Each level doubles the number of nodes
            const treeDepth = 10; // 2^10 = 1024 leaf nodes
            const nodeDefs = [];

            // Root node
            nodeDefs.push({
                output: "node_0_0",
                inputs: [],
                computor: (_inputs, oldValue, _bindings) => oldValue || { value: 1 },
                isDeterministic: true,
                hasSideEffects: false,
            });

            // Build tree
            for (let level = 0; level < treeDepth; level++) {
                const nodesInLevel = Math.pow(2, level);
                for (let i = 0; i < nodesInLevel; i++) {
                    const parentNode = `node_${level}_${i}`;
                    const leftChild = `node_${level + 1}_${i * 2}`;
                    const rightChild = `node_${level + 1}_${i * 2 + 1}`;

                    // Left child
                    nodeDefs.push({
                        output: leftChild,
                        inputs: [parentNode],
                        computor: (inputs, _oldValue, _bindings) => {
                            const parent = inputs[0];
                            return { value: parent.value };
                        },
                        isDeterministic: true,
                        hasSideEffects: false,
                    });

                    // Right child
                    nodeDefs.push({
                        output: rightChild,
                        inputs: [parentNode],
                        computor: (inputs, _oldValue, _bindings) => {
                            const parent = inputs[0];
                            return { value: parent.value };
                        },
                        isDeterministic: true,
                        hasSideEffects: false,
                    });
                }
            }

            const graph = makeDependencyGraph(db, nodeDefs);

            // Set root value
            await graph.set("node_0_0", { value: 42 });

            // Check a few leaf nodes
            const leafNode1 = await graph.pull(`node_${treeDepth}_0`);
            expect(leafNode1.value).toBe(42);

            const leafNode2 = await graph.pull(`node_${treeDepth}_${Math.pow(2, treeDepth) - 1}`);
            expect(leafNode2.value).toBe(42);

            // Update root - should propagate to all nodes without stack overflow
            await graph.set("node_0_0", { value: 100 });

            const updatedLeaf = await graph.pull(`node_${treeDepth}_0`);
            expect(updatedLeaf.value).toBe(100);

            await db.close();
        });
    });

    describe("validateAcyclic with deep graph structures", () => {
        test("handles deep linear chain without stack overflow", () => {
            const depth = 1000;
            const nodeDefs = [];

            // Create a chain: node0 -> node1 -> node2 -> ... -> node999
            nodeDefs.push({
                output: "node0",
                inputs: [],
                computor: () => ({}),
                isDeterministic: true,
                hasSideEffects: false,
            });

            for (let i = 1; i < depth; i++) {
                nodeDefs.push({
                    output: `node${i}`,
                    inputs: [`node${i - 1}`],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                });
            }

            const compiledNodes = nodeDefs.map(compileNodeDef);

            // Should not throw (acyclic) and should not cause stack overflow
            expect(() => validateAcyclic(compiledNodes)).not.toThrow();
        });

        test("detects cycle in deep graph structure", () => {
            const depth = 100;
            const nodeDefs = [];

            // Create a chain with a cycle: node0 depends on last node
            nodeDefs.push({
                output: "node0",
                inputs: [`node${depth - 1}`],
                computor: () => ({}),
                isDeterministic: true,
                hasSideEffects: false,
            });

            for (let i = 1; i < depth; i++) {
                nodeDefs.push({
                    output: `node${i}`,
                    inputs: [`node${i - 1}`],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                });
            }

            const compiledNodes = nodeDefs.map(compileNodeDef);

            // Should detect cycle without stack overflow
            expect(() => validateAcyclic(compiledNodes)).toThrow(/cycle/i);
        });

        test("handles complex graph with multiple paths without stack overflow", () => {
            // Create a diamond-like structure repeated many times
            const layers = 50;
            const nodeDefs = [];

            nodeDefs.push({
                output: "layer0_node0",
                inputs: [],
                computor: () => ({}),
                isDeterministic: true,
                hasSideEffects: false,
            });

            for (let layer = 0; layer < layers; layer++) {
                const prevLayerNode = `layer${layer}_node0`;
                const leftNode = `layer${layer + 1}_left`;
                const rightNode = `layer${layer + 1}_right`;
                const nextLayerNode = `layer${layer + 1}_node0`;

                // Create diamond pattern
                nodeDefs.push({
                    output: leftNode,
                    inputs: [prevLayerNode],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                });

                nodeDefs.push({
                    output: rightNode,
                    inputs: [prevLayerNode],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                });

                nodeDefs.push({
                    output: nextLayerNode,
                    inputs: [leftNode, rightNode],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                });
            }

            const compiledNodes = nodeDefs.map(compileNodeDef);

            // Should not throw and should not cause stack overflow
            expect(() => validateAcyclic(compiledNodes)).not.toThrow();
        });
    });
});
