const path = require('path');
const fs = require('fs');
const temporary = require('./temporary');
const logger = require('../src/logger');

logger.setup();

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const path = require("path");
    const temporary = require("./temporary");
    return {
        openaiAPIKey: jest.fn().mockReturnValue("test-key"),
        resultsDirectory: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "results");
        }),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
        logFile: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "log.txt");
        }),
    };
});

// Mock notifications to verify error handling
jest.mock('../src/notifications', () => ({
    notifyAboutError: jest.fn().mockResolvedValue(undefined),
}));

// Mock the OpenAI client to avoid real API calls
jest.mock('openai', () => {
    // Stubbed create method returns a fixed response
    const createMock = jest.fn().mockResolvedValue('foo bar baz');
    return {
        OpenAI: jest.fn().mockImplementation(() => ({
            audio: {
                transcriptions: { create: createMock },
            },
        })),
    };
});

const request = require('supertest');
const expressApp = require('../src/express_app');
const { uploadDir } = require('../src/config');
const { notifyAboutError } = require('../src/notifications');
const { addRoutes } = require('../src/startup');

describe('GET /api/transcribe', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('responds with 400 if input or output param missing', async () => {
        const app = expressApp.make();
        await addRoutes(app);
        const reqId = 'testreq';
        const res = await request(app)
            .get('/api/transcribe')
            .query({ request_identifier: reqId });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            success: false,
            error: 'Please provide the input parameter',
        });
        expect(notifyAboutError).toHaveBeenCalledWith('Transcription request failed - missing input');
    });

    it('responds with 404 if input file does not exist', async () => {
        const app = expressApp.make();
        await addRoutes(app);
        const reqId = 'testreq';
        const res = await request(app)
              .get('/api/transcribe')
              .query({ request_identifier: reqId, input: '/nonexistent/file.wav' });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ success: false, error: 'Input file not found' });
        expect(notifyAboutError).toHaveBeenCalledWith('Transcription request failed - file not found');
    });

    it('transcribes and saves output file on valid input', async () => {
        const app = expressApp.make();
        await addRoutes(app);
        // Prepare a dummy input file
        const inputDir = temporary.input();
        const inputPath = path.join(inputDir, 'dummy.wav');
        fs.mkdirSync(path.dirname(inputPath), { recursive: true });
        fs.writeFileSync(inputPath, 'dummy content');

        const reqId = 'testreq';
        const outputFilename = 'transcription.json';
        const res = await request(app)
              .get('/api/transcribe')
              .query({ request_identifier: reqId, input: inputPath });

        // Verify response
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        // Verify file was written to uploadDir under the request identifier
        const savedPath = path.join(uploadDir, reqId, outputFilename);
        expect(fs.existsSync(savedPath)).toBe(true);
        const content = fs.readFileSync(savedPath, 'utf8');
        // Parsed content should match the stubbed response
        expect(JSON.parse(content)).toEqual({
            "text": "foo bar baz",
            "transcriber": {
                "creator": "OpenAI",
                "name": "gpt-4o-mini-transcribe",
            },
        });
    });
});
