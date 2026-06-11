const {
    projectValueRootToVirtualFiles,
    virtualKeyToPhysicalPath,
    encodeObjectKeySegment,
} = require('../src/generators/incremental_graph/database/render');

describe('exploded JSON virtual projection', () => {
    test('[19.1-7/8] scalar emits paired schema and root rendered files', () => {
        expect(projectValueRootToVirtualFiles('r/values/nodeA', true)).toEqual([
            { key: 'r/values/nodeA\x00k\x00', content: '"boolean"' },
            { key: 'r/values/nodeA\x00r\x00', content: 'true' },
        ]);
    });

    test('[19.1-12] object emits schema and sorted descendant leaves', () => {
        expect(projectValueRootToVirtualFiles('r/values/nodeA', { z: 2, a: { b: 'text' } })).toEqual([
            {
                key: 'r/values/nodeA\x00k\x00',
                content: '{\n  "a": {\n    "b": "string"\n  },\n  "z": "number"\n}',
            },
            { key: 'r/values/nodeA\x00r\x00a/b', content: 'text' },
            { key: 'r/values/nodeA\x00r\x00z', content: '2' },
        ]);
    });

    test.each([{}, []])('[19.1-13/14] primitive-free root %p emits schema only', (value) => {
        const files = projectValueRootToVirtualFiles('r/values/empty', value);
        expect(files).toHaveLength(1);
        expect(files[0].key).toBe('r/values/empty\x00k\x00');
    });

    test('[19.1-24/25] dangerous object keys use canonical segment encoding', () => {
        expect(['', '%00', '.', '%2E', '..', 'a/b', '50%off', 'a!b', '%2F', '0'].map(encodeObjectKeySegment)).toEqual([
            '%00', '%2500', '%2E', '%252E', '%2E%2E', 'a%2Fb', '50%25off', 'a%21b', '%252F', '0',
        ]);
    });

    test('[19.1-28] arrays use unpadded numeric indices', () => {
        const keys = projectValueRootToVirtualFiles('r/values/list', Array.from({ length: 11 }, (_, index) => index))
            .map((entry) => entry.key);
        expect(keys).toContain('r/values/list\x00r\x0010');
        expect(keys).not.toContain('r/values/list\x00r\x00010');
    });

    test('[19.1-27] virtual sorting keeps each value projection together', () => {
        const keys = [
            ...projectValueRootToVirtualFiles('r/values/nodeB', { name: 'B' }),
            ...projectValueRootToVirtualFiles('r/values/nodeA', { items: [1], name: 'A' }),
        ].map((entry) => entry.key).sort();
        expect(keys).toEqual([
            'r/values/nodeA\x00k\x00',
            'r/values/nodeA\x00r\x00items/0',
            'r/values/nodeA\x00r\x00name',
            'r/values/nodeB\x00k\x00',
            'r/values/nodeB\x00r\x00name',
        ]);
    });

    test('virtual keys map to sibling physical trees', () => {
        expect(virtualKeyToPhysicalPath('/snapshot', 'r/values/nodeA\x00k\x00')).toBe('/snapshot/kindtree/r/values/nodeA');
        expect(virtualKeyToPhysicalPath('/snapshot', 'r/values/nodeA\x00r\x00items/0')).toBe('/snapshot/rendered/r/values/nodeA/items/0');
    });

    test('[19.1-29] _meta sublevel uses same projection rules as other sublevels', () => {
        const files = projectValueRootToVirtualFiles('_meta/current_replica', 'r');
        expect(files).toEqual([
            { key: '_meta/current_replica\x00k\x00', content: '"string"' },
            { key: '_meta/current_replica\x00r\x00', content: 'r' },
        ]);
    });
});
