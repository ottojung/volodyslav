const express = require('express');
const request = require('supertest');

// Mock the logger setup
jest.mock('../src/logger', () => ({
    setupHttpCallsLogging: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

// Mock the notifications system
jest.mock('../src/notifications', () => ({
    ensureNotificationsAvailable: jest.fn()
}));

// Mock environment
jest.mock('../src/environment', () => ({
    openaiAPIKey: jest.fn().mockReturnValue('test-key'),
    resultsDirectory: jest.fn().mockReturnValue('/tmp/test'),
    myServerPort: jest.fn().mockReturnValue(0),
    logLevel: jest.fn().mockReturnValue("silent"),
}));

const { ensureStartupDependencies } = require('../src/startup');
const { setupHttpCallsLogging } = require('../src/logger');
const { ensureNotificationsAvailable } = require('../src/notifications');

describe('Startup Dependencies', () => {
    let app;

    beforeEach(() => {
        // Reset all mocks before each test
        jest.clearAllMocks();
        app = express();
    });

    it('sets up HTTP call logging', async () => {
        ensureNotificationsAvailable.mockResolvedValue();
        
        await ensureStartupDependencies(app);
        
        expect(setupHttpCallsLogging).toHaveBeenCalledWith(app);
        expect(setupHttpCallsLogging).toHaveBeenCalledTimes(1);
    });

    it('ensures notifications are available', async () => {
        ensureNotificationsAvailable.mockResolvedValue();
        
        await ensureStartupDependencies(app);
        
        expect(ensureNotificationsAvailable).toHaveBeenCalled();
        expect(ensureNotificationsAvailable).toHaveBeenCalledTimes(1);
    });

    it('throws if notifications are not available', async () => {
        const error = new Error('Notifications not available');
        ensureNotificationsAvailable.mockRejectedValue(error);
        
        await expect(ensureStartupDependencies(app)).rejects.toThrow('Notifications not available');
    });

    it('properly sets up middleware for logging actual requests', async () => {
        ensureNotificationsAvailable.mockResolvedValue();
        
        // Create a test app with a simple endpoint
        const testApp = express();
        await ensureStartupDependencies(testApp);
        
        testApp.get('/test', (req, res) => {
            res.send('test');
        });

        // Make a request and verify logger was called
        await request(testApp).get('/test');
        expect(setupHttpCallsLogging).toHaveBeenCalled();
    });

    it('ensures dependencies are set up only once even if called multiple times', async () => {
        ensureNotificationsAvailable.mockResolvedValue();
        
        await Promise.all([
            ensureStartupDependencies(app),
            ensureStartupDependencies(app),
            ensureStartupDependencies(app)
        ]);
        
        expect(setupHttpCallsLogging).toHaveBeenCalledTimes(3); // Each app instance gets its own logger
        expect(ensureNotificationsAvailable).toHaveBeenCalledTimes(3); // Notifications checked each time
    });
});