// Mock environment exports to avoid real env dependencies
jest.mock('../src/environment', () => {
    const path = require('path');
    const temporary = require('./temporary');
    return {
        openaiAPIKey: jest.fn().mockReturnValue('test-key'),
        resultsDirectory: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), 'results');
        }),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
        logFile: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), 'log.txt');
        }),
    };
});

const request = require('supertest');
const expressApp = require('../src/express_app');
const { addRoutes } = require('../src/startup');
const logger = require('../src/logger');

describe('GET /api/ping', () => {
  it('responds with pong', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).get('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('pong');
  });

  it('returns text/html content type', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).get('/api/ping');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('handles HEAD request', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).head('/api/ping');
    expect(res.statusCode).toBe(200);
  });

  it('rejects POST requests', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).post('/api/ping');
    expect(res.statusCode).toBe(404);
  });

  it('rejects PUT requests', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).put('/api/ping');
    expect(res.statusCode).toBe(404);
  });

  it('rejects DELETE requests', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).delete('/api/ping');
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 when runtime_identifier matches', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const correctId = require('../src/runtime_identifier').instanceIdentifier;
    const res = await request(app).get(`/api/ping?runtime_identifier=${correctId}`);
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('pong');
  });

  it('returns 400 when runtime_identifier is empty', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).get('/api/ping?runtime_identifier=');
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when runtime_identifier does not match', async () => {
    await logger.setup();
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).get('/api/ping?runtime_identifier=wrong-id');
    expect(res.statusCode).toBe(400);
  });
});
