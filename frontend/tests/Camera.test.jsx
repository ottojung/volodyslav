import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Camera from '../src/Camera';

describe('Camera component', () => {
  let getUserMediaMock;

  beforeAll(() => {
    // Mock navigator.mediaDevices.getUserMedia
    if (!navigator.mediaDevices) {
      navigator.mediaDevices = {};
    }
    getUserMediaMock = jest.fn().mockResolvedValue(
      { getTracks: () => [{ stop: jest.fn() }] } /* mock MediaStream */
    );
    navigator.mediaDevices.getUserMedia = getUserMediaMock;
    // Mock video.play()
    jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    // Mock canvas methods
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage: jest.fn() });
    HTMLCanvasElement.prototype.toBlob = function(callback) {
      callback(new Blob(['dummy'], { type: 'image/jpeg' }));
    };
    // Mock URL APIs
    // Define createObjectURL and revokeObjectURL since they may not exist in JSDOM
    URL.createObjectURL = jest.fn(() => 'blob:url');
    URL.revokeObjectURL = jest.fn();
    // Mock fetch for upload
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    // Suppress error logs from fetch failures
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
    // Clean up fetch mock
    delete global.fetch;
  });

  // Reset fetch call count before each test
  beforeEach(() => {
    global.fetch.mockClear();
  });

  test('initial render shows Take Photo and Done buttons', () => {
    render(<Camera />);
    expect(screen.getByText('Take Photo')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText('Redo')).not.toBeInTheDocument();
    expect(screen.queryByText('More')).not.toBeInTheDocument();
  });

  test('takes photo and shows preview with controls', async () => {
    render(<Camera />);
    // Wait for camera access
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Take Photo'));
    // Preview should appear
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:url');
    expect(screen.getByText('Redo')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText('Take Photo')).not.toBeInTheDocument();
  });

  test('More button returns to camera mode', async () => {
    render(<Camera />);
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => screen.getByAltText('Preview'));
    fireEvent.click(screen.getByText('More'));
    expect(screen.getByText('Take Photo')).toBeInTheDocument();
    // Preview image remains in DOM but should be hidden
    expect(screen.getByAltText('Preview')).not.toBeVisible();
  });

  test('Redo button also returns to camera mode', async () => {
    render(<Camera />);
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => screen.getByAltText('Preview'));
    fireEvent.click(screen.getByText('Redo'));
    expect(screen.getByText('Take Photo')).toBeInTheDocument();
    // Preview image remains in DOM but should be hidden
    expect(screen.getByAltText('Preview')).not.toBeVisible();
  });

  test('Done button without photos alerts user', () => {
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});
    render(<Camera />);
    fireEvent.click(screen.getByText('Done'));
    expect(alertMock).toHaveBeenCalledWith('No photos to upload.');
    alertMock.mockRestore();
  });

  test('Done button with photos uploads and shows success alert', async () => {
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});
    render(<Camera />);
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => screen.getByAltText('Preview'));
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:5000/upload',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) })
    );
    expect(alertMock).toHaveBeenCalledWith('Upload successful.');
    alertMock.mockRestore();
  });

  test('Done button upload failure alerts error', async () => {
    // Simulate server error response
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});
    render(<Camera />);
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => screen.getByAltText('Preview'));
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(alertMock).toHaveBeenCalledWith(
      expect.stringContaining('Error uploading photos')
    ));
    alertMock.mockRestore();
  });
  test('Done button uploads multiple photos correctly', async () => {
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});
    render(<Camera />);
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    // Take first photo
    fireEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => screen.getByAltText('Preview'));
    // Add to photos (More) and return to camera
    fireEvent.click(screen.getByText('More'));
    expect(screen.getByText('Take Photo')).toBeInTheDocument();
    // Take second photo
    fireEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => screen.getByAltText('Preview'));
    // Upload all photos
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const formData = global.fetch.mock.calls[0][1].body;
    let photoEntries = [];
    if (typeof formData.getAll === 'function') {
      photoEntries = formData.getAll('photos');
    } else {
      photoEntries = Array.from(formData.entries())
        .filter(([name]) => name === 'photos')
        .map(([, value]) => value);
    }
    expect(photoEntries.length).toBe(2);
    alertMock.mockRestore();
  });
});

