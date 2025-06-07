const os = require('os');
const path = require('path');
const deleter = require('../src/filesystem/deleter');

describe('deleteDirectory', () => {
  it('throws FileNotFoundError when directory does not exist', async () => {
    const dir = path.join(os.tmpdir(), 'nonexistent-' + Date.now());
    const d = deleter.make();
    await expect(d.deleteDirectory(dir)).rejects.toMatchObject({ filePath: dir });
  });
});
