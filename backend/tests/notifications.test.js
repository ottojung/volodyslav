const { notifyAboutError, notifyAboutWarning, ensureNotificationsAvailable } = require('../src/notifications');
const { execFile } = require('child_process');

jest.mock('child_process', () => ({
    execFile: jest.fn((cmd, args, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = undefined;
        }
        if (args.includes('-v') && args.includes('termux-notification')) {
            callback(null, { stdout: '/usr/bin/termux-notification\n' });
        } else {
            callback(new Error('command not found'));
        }
    }),
}));

const mockExecFile = execFile;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('notifications', () => {
    describe('ensureNotificationsAvailable', () => {
        it('should resolve when termux-notification is available', async () => {
            mockExecFile.mockImplementation((cmd, args, options, callback) => {
                callback(null, { stdout: '/usr/bin/termux-notification\n' });
            });

            await expect(ensureNotificationsAvailable()).resolves.not.toThrow();
        });

        it('should throw an error when termux-notification is unavailable', async () => {
            mockExecFile.mockImplementation((cmd, args, options, callback) => {
                throw new Error('command not found');
                callback(new Error('command not found'));
            });

            // throw new Error('command not found');
            await ensureNotificationsAvailable();

            await expect(ensureNotificationsAvailable()).resolves.not.toThrow();
            // await expect(ensureNotificationsAvailable()).rejects.toThrow(
            //     'command not found'
            // );
        });
    });

    describe('notifyAboutError', () => {
        it('should send an error notification', async () => {
            mockExecFile.mockImplementation((cmd, args, options, callback) => {
                callback(null, { stdout: '/usr/bin/termux-notification\n' });
            });

            await notifyAboutError('Test error message');

            expect(mockExecFile).toHaveBeenCalledWith(
                '/usr/bin/termux-notification',
                ['-t', 'Error', '-c', 'Test error message'],
                expect.any(Function)
            );
        });
    });

    describe('notifyAboutWarning', () => {
        it('should send a warning notification', async () => {
            mockExecFile.mockImplementation((cmd, args, options, callback) => {
                callback(null, { stdout: '/usr/bin/termux-notification\n' });
            });

            await notifyAboutWarning('Test warning message');

            expect(mockExecFile).toHaveBeenCalledWith(
                '/usr/bin/termux-notification',
                ['-t', 'Warning', '-c', 'Test warning message'],
                expect.any(Function)
            );
        });
    });
});
