const { notifyAboutError, notifyAboutWarning, ensureNotificationsAvailable } = require('../src/notifications');
const { callSubprocess } = require('../src/subprocess');

jest.mock('../src/subprocess', () => ({
    callSubprocess: jest.fn((cmd, args) => { // Removed unused 'options' parameter
        if (args.includes('-v') && args.includes('termux-notification')) {
            return Promise.resolve({ stdout: '/usr/bin/termux-notification\n' });
        } else {
            return Promise.reject(new Error('command not found'));
        }
    }),
}));

const mockCallSubprocess = callSubprocess;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('notifications', () => {
    describe('ensureNotificationsAvailable', () => {
        it('should resolve when termux-notification is available', async () => {
            mockCallSubprocess.mockResolvedValue({ stdout: '/usr/bin/termux-notification\n' });
            // NOTE: this ^^ doesn't work!!!!

            await expect(ensureNotificationsAvailable()).resolves.not.toThrow();
        });

        it('should throw an error when termux-notification is unavailable', async () => {
            // TODO: implement.
        });
    });

    describe('notifyAboutError', () => {
        it('should send an error notification', async () => {
            mockCallSubprocess.mockResolvedValue({ stdout: '/usr/bin/termux-notification\n' });

            await notifyAboutError('Test error message');

            expect(mockCallSubprocess).toHaveBeenCalledWith(
                '/usr/bin/termux-notification',
                ['-t', 'Error', '-c', 'Test error message'],
                {}
            );
        });
    });

    describe('notifyAboutWarning', () => {
        it('should send a warning notification', async () => {
            mockCallSubprocess.mockResolvedValue({ stdout: '/usr/bin/termux-notification\n' });

            await notifyAboutWarning('Test warning message');

            expect(mockCallSubprocess).toHaveBeenCalledWith(
                '/usr/bin/termux-notification',
                ['-t', 'Warning', '-c', 'Test warning message'],
                {}
            );
        });
    });
});
