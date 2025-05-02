import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Camera from './Camera';

describe('Camera component', () => {
  let getUserMediaMock;

  beforeAll(() => {
    // Mock navigator.mediaDevices.getUserMedia
    getUserMediaMock = jest.spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementation(() => Promise.resolve({ getTracks: () => [{ stop: jest.fn() }] }));
    // Mock video.play()
    jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    // Mock canvas methods
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage: jest.fn() });
    HTMLCanvasElement.prototype.toBlob = function(callback) {
      callback(new Blob(['dummy'], { type: 'image/jpeg' }));
    };
    // Mock URL APIs
    jest.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:url');
    jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
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
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });

  test('Redo button also returns to camera mode', async () => {
    render(<Camera />);
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => screen.getByAltText('Preview'));
    fireEvent.click(screen.getByText('Redo'));
    expect(screen.getByText('Take Photo')).toBeInTheDocument();
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });

  test('Done button without photos alerts user', () => {
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});
    render(<Camera />);
    fireEvent.click(screen.getByText('Done'));
    expect(alertMock).toHaveBeenCalledWith('No photos to download.');
    alertMock.mockRestore();
  });
});