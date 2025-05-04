
// Mock environment exports to avoid real env dependencies
jest.mock('../src/environment', () => ({
    openaiAPIKey: jest.fn().mockReturnValue('test-key'),
    myRoot: jest.fn().mockReturnValue(__dirname),
    myServerPort: jest.fn().mockReturnValue(0),
    logLevel: jest.fn().mockReturnValue("silent"),
}));

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const app = require('../src/index');
const { uploadDir } = require('../src/config');

describe('POST /api/upload', () => {
  // Clean up uploaded files after each test
  afterEach(() => {
    if (fs.existsSync(uploadDir)) {
      fs.readdirSync(uploadDir).forEach((file) => {
        const filePath = path.join(uploadDir, file);
        fs.unlinkSync(filePath);
      });
    }
  });

  it('uploads a single file successfully', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('photos', Buffer.from('test content'), 'test1.jpg');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, files: ['test1.jpg'] });
    expect(fs.existsSync(path.join(uploadDir, 'test1.jpg'))).toBe(true);
  });

  it('uploads multiple files successfully', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('photos', Buffer.from('first'), 'first.jpg')
      .attach('photos', Buffer.from('second'), 'second.jpg');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, files: ['first.jpg', 'second.jpg'] });
    expect(fs.existsSync(path.join(uploadDir, 'first.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(uploadDir, 'second.jpg'))).toBe(true);
  });

  it('responds with empty files array when no files are sent', async () => {
    const res = await request(app).post('/api/upload');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, files: [] });
  });
});
