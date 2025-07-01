const path = require('path');
const { execFile } = require('child_process');

describe('CLI', () => {
    test('prints unknown command error', async () => {
        const cliPath = path.join(__dirname, '..', 'src', 'index.js');
        await new Promise((resolve, _reject) => {
            execFile('node', [cliPath, 'unknown'], (error, stdout, stderr) => {
                expect(error).not.toBeNull();
                expect(stderr).toContain("error: unknown command 'unknown'");
                expect(stderr).not.toContain('too many arguments');
                resolve();
            });
        });
    });
});
