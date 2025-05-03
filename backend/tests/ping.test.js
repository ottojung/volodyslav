const request = require('supertest');
const app = require('../src/index');

describe('GET /api/ping', () => {
  it('responds with pong', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('pong');
  });
});
