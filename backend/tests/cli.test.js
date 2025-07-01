const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');

const execFileAsync = promisify(execFile);
const cliPath = path.join(__dirname, '..', 'src', 'index.js');

describe('CLI', () => {
    test('unknown command shows helpful message', async () => {
        await expect(execFileAsync('node', [cliPath, 'unknown'])).rejects.toMatchObject({
            code: expect.any(Number),
            stderr: expect.stringMatching(/unknown command/i),
        });
    });

    test('--version displays version', async () => {
        const { stdout } = await execFileAsync('node', [cliPath, '--version']);
        expect(stdout.trim()).not.toHaveLength(0);
    });
});
