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

describe('GET /api', () => {
  it('responds with Hello World!', async () => {
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).get('/api');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('Hello World!');
  });

  it('returns text/html content type', async () => {
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).get('/api');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('handles HEAD request', async () => {
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).head('/api');
    expect(res.statusCode).toBe(200);
  });

  it('handles invalid HTTP method', async () => {
    const app = expressApp.make();
    await addRoutes(app);
    const res = await request(app).put('/api');
    expect(res.statusCode).toBe(404);
  });
});
