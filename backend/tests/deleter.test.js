const os = require('os');
const path = require('path');
const deleter = require('../src/filesystem/deleter');

describe('deleteDirectory', () => {
  it('throws FileNotFoundError when directory does not exist', async () => {
    const dir = path.join(os.tmpdir(), 'nonexistent-' + Math.random().toString(36).substr(2, 9));
    const d = deleter.make();
    await expect(d.deleteDirectory(dir)).rejects.toMatchObject({ filePath: dir });
  });
});
