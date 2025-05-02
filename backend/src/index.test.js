const request = require('supertest');
const app = require('./index');

describe('GET /', () => {
  it('responds with Hello World!', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('Hello World!');
  });
});

describe('GET /camera.html', () => {
  it('serves the camera.html static file', async () => {
    const res = await request(app).get('/camera.html');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<title>Instant Photo Shooter</title>');
  });
});