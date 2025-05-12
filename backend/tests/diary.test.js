// backend/tests/diary.test.js
const path = require('path');

jest.mock('fs/promises', () => ({
  copyFile: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('../src/transcribe_all', () => ({
  transcribeAllGeneric: jest.fn(),
}));

jest.mock('../src/environment', () => ({
  diaryAudiosDirectory: jest.fn(),
  eventLogAssetsDirectory: jest.fn(),
}));

jest.mock('../src/format_time_stamp', () => ({
  formatFileTimestamp: jest.fn(),
}));

jest.mock('../src/event_log_storage', () => ({
  transaction: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  logError: jest.fn(),
}));

const { processDiaryAudios } = require('../src/diary');
const { transcribeAllGeneric } = require('../src/transcribe_all');
const { copyFile, unlink } = require('fs/promises');
const { diaryAudiosDirectory, eventLogAssetsDirectory } = require('../src/environment');
const { formatFileTimestamp } = require('../src/format_time_stamp');
const { transaction } = require('../src/event_log_storage');
const { logError } = require('../src/logger');

describe('processDiaryAudios', () => {
  let storage;
  beforeEach(() => {
    jest.resetAllMocks();
    storage = { addEntry: jest.fn() };
    diaryAudiosDirectory.mockReturnValue('/fake/diaryDir');
    eventLogAssetsDirectory.mockReturnValue('/fake/assetsDir');
    formatFileTimestamp.mockReturnValue('2025-05-12');
    transcribeAllGeneric.mockResolvedValue({
      successes: ['file1.mp3', 'file2.mp3'],
      failures: [{ file: 'bad.mp3', message: 'error occurred' }],
    });
    transaction.mockImplementation(async (cb) => {
      await cb(storage);
    });
  });

  it('should process diary audios correctly', async () => {
    await processDiaryAudios();

    // Failures logged
    expect(logError).toHaveBeenCalledWith(
      { file: 'bad.mp3', error: 'error occurred', directory: '/fake/diaryDir' },
      expect.stringContaining('Diary audio transcription failed')
    );

    // Files copied
    expect(copyFile).toHaveBeenCalledTimes(2);
    expect(copyFile).toHaveBeenCalledWith(
      '/fake/diaryDir/file1.mp3',
      path.join('/fake/assetsDir', '2025-05-12', 'file1.mp3')
    );
    expect(copyFile).toHaveBeenCalledWith(
      '/fake/diaryDir/file2.mp3',
      path.join('/fake/assetsDir', '2025-05-12', 'file2.mp3')
    );

    // Original files deleted
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith('/fake/diaryDir/file1.mp3');
    expect(unlink).toHaveBeenCalledWith('/fake/diaryDir/file2.mp3');

    // Event log entries added
    expect(transaction).toHaveBeenCalled();
    expect(storage.addEntry).toHaveBeenCalledTimes(2);
    const expectedEvent = {
      date: '2025-05-12',
      original: 'diary [when 0 hours ago]',
      input: 'diary [when 0 hours ago]',
      modifiers: { when: '0 hours ago' },
      type: 'diary',
      description: '',
    };
    expect(storage.addEntry).toHaveBeenNthCalledWith(1, expectedEvent, 0, expect.any(Array));
    expect(storage.addEntry).toHaveBeenNthCalledWith(2, expectedEvent, 1, expect.any(Array));
  });
});
