const path = require('path');
const fs = require('fs');

// Set up environment variables before loading the app
process.env.MY_ROOT = path.join(__dirname, 'tmp');
process.env.OPENAI_API_KEY = 'test-key';

// Mock the OpenAI client to avoid real API calls
jest.mock('openai', () => {
  // Stubbed create method returns a fixed response
  const createMock = jest.fn().mockResolvedValue({ foo: 'bar' });
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
    const res = await request(app).get('/api/transcribe');
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Please provide both input and output parameters',
    });
  });

  it('responds with 404 if input file does not exist', async () => {
    const res = await request(app)
      .get('/api/transcribe')
      .query({ input: '/nonexistent/file.wav', output: 'out.json' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Input file not found' });
  });

  it('transcribes and saves output file on valid input', async () => {
    // Prepare a dummy input file
    const inputDir = path.join(__dirname, 'tmp');
    const inputPath = path.join(inputDir, 'dummy.wav');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, 'dummy content');

    const outputFilename = 'result.json';
    const res = await request(app)
      .get('/api/transcribe')
      .query({ input: inputPath, output: outputFilename });

    // Verify response
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });

    // Verify file was written to storageDir
    const savedPath = path.join(storageDir, outputFilename);
    expect(fs.existsSync(savedPath)).toBe(true);
    const content = fs.readFileSync(savedPath, 'utf8');
    // Parsed content should match the stubbed response
    expect(JSON.parse(content)).toEqual({ foo: 'bar' });
  });
});