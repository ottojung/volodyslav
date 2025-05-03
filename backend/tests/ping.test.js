// Set up required environment variables before loading the app
process.env.MY_ROOT = __dirname;
process.env.MY_SERVER_PORT = '0';
process.env.OPENAI_API_KEY = 'test-key';
const request = require('supertest');
const app = require('../src/index');

describe('GET /api/ping', () => {
  it('responds with pong', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('pong');
  });
});
