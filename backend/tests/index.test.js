// Set up required environment variables before loading the app
process.env.MY_ROOT = __dirname;       // root for storage (not used by this test)
process.env.MY_SERVER_PORT = '0';      // port (not used when require.main !== module)
process.env.OPENAI_API_KEY = 'test-key'; // required by OpenAI client instantiation
const request = require('supertest');
const app = require('../src/index');

describe('GET /api', () => {
  it('responds with Hello World!', async () => {
    const res = await request(app).get('/api');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('Hello World!');
  });
});
