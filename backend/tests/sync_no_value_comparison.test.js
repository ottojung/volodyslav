const fs = require('fs');
const path = require('path');

describe('sync merge does not compare ComputedValue payloads', () => {
    test('planner avoids value reads and equality helpers', () => {
        const databaseDir = path.join(__dirname, '..', 'src', 'generators', 'incremental_graph', 'database');
        const planner = fs.readFileSync(path.join(databaseDir, 'sync_merge_plan.js'), 'utf8');
        const syncSources = [
            'sync_merge_plan.js',
            'sync_merge_source_state.js',
            'sync_merge_validity.js',
            'sync_merge.js',
        ].map(file => fs.readFileSync(path.join(databaseDir, file), 'utf8')).join('\n');

        expect(planner).not.toMatch(/\.values\.get\s*\(/);
        expect(syncSources).not.toMatch(/dequal|deepEqual|isEqual/);
    });
});
