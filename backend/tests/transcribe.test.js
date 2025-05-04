const path = require('path');
const fs = require('fs');

// Mock environment exports to avoid real env dependencies
jest.mock('../src/environment', () => {
    const path = require('path');
    return {
        openaiAPIKey: jest.fn().mockReturnValue('test-key'),
        myRoot: jest.fn().mockReturnValue(path.join(__dirname, 'tmp')),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
    };
});

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
const app = require('../src/index');
const { uploadDir: storageDir } = require('../src/config');

// Ensure a clean test directory
beforeAll(() => {
    // Clean any pre-existing tmp directory
    const tmpRoot = path.join(__dirname, 'tmp');
    if (fs.existsSync(tmpRoot)) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    // Ensure upload directory exists
    fs.mkdirSync(storageDir, { recursive: true });
});

afterAll(() => {
    // Remove tmp directory after tests
    if (fs.existsSync(path.join(__dirname, 'tmp'))) {
        fs.rmSync(path.join(__dirname, 'tmp'), { recursive: true, force: true });
    }
});

describe('GET /api/transcribe', () => {
    it('responds with 400 if input or output param missing', async () => {
        const reqId = 'testreq';
        const res = await request(app)
            .get('/api/transcribe')
            .query({ request_identifier: reqId });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            success: false,
            error: 'Please provide the input parameter',
        });
    });

    it('responds with 404 if input file does not exist', async () => {
        const reqId = 'testreq';
        const res = await request(app)
              .get('/api/transcribe')
              .query({ request_identifier: reqId, input: '/nonexistent/file.wav' });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ success: false, error: 'Input file not found' });
    });

    it('transcribes and saves output file on valid input', async () => {
        // Prepare a dummy input file
        const inputDir = path.join(__dirname, 'tmp');
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

        // Verify file was written to storageDir under the request identifier
        const savedPath = path.join(storageDir, reqId, outputFilename);
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
