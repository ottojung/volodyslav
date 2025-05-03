import React, { useState, useRef, useEffect } from 'react';
import { Box, Flex, Button, Image, useToast } from '@chakra-ui/react';
import {
  containerProps,
  videoContainerProps,
  videoProps,
  imageProps,
  controlsProps,
  buttonProps,
} from './Camera.styles';

export default function Camera() {
  const [currentBlob, setCurrentBlob] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [mode, setMode] = useState('camera'); // 'camera' or 'preview'
  const videoRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };
    navigator.mediaDevices.getUserMedia(constraints)
      .then((stream) => {
        video.srcObject = stream;
        video.play();
      })
      .catch((err) => {
        toast({
          title: 'Error accessing camera',
          description: err?.message || String(err),
          status: 'error',
          duration: null,
          isClosable: true,
          position: 'top',
        });
      });
    return () => {
      const stream = video.srcObject;
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(
          /** @param {MediaStreamTrack} track */
          (track) => track.stop()
        );
      }
    };
  }, []);

  /**
   * Adds the current blob to the photos list
   * @param {Blob|null} blob
   */
  const addLastPhoto = (blob) => {
    if (blob) {
      setPhotos((prev) => {
        const idx = prev.length + 1;
        const index = String(idx).padStart(2, '0');
        return [...prev, { blob, name: `photo_${index}.jpg` }];
      });
      setCurrentBlob(null);
    }
  };

  const handleTake = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => {
      if (b) {
        const url = URL.createObjectURL(b);
        setPreviewUrl(url);
        setCurrentBlob(b);
        setMode('preview');
      }
    }, 'image/jpeg', 1.0);
  };

  const resetCamera = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setMode('camera');
  };

  const handleMore = () => {
    addLastPhoto(currentBlob);
    resetCamera();
  };

  const handleRedo = () => {
    setCurrentBlob(null);
    resetCamera();
  };

  const handleDone = async () => {
    resetCamera();

    const allPhotos = currentBlob
      ? [...photos, { blob: currentBlob, name: `photo_${String(photos.length + 1).padStart(2, '0')}.jpg` }]
      : photos;
    if (allPhotos.length === 0) {
      toast({
        title: 'No photos to upload',
        status: 'error',
        duration: 3000,
        isClosable: true,
        position: 'top',
      });
      return;
    }

    const formData = new FormData();
    allPhotos.forEach((p) => {
      formData.append('photos', p.blob, p.name);
    });

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      await response.json();
      toast({
        title: 'Upload successful',
        status: 'success',
        duration: 3000,
        isClosable: true,
        position: 'top',
      });
      setPhotos([]);
      setCurrentBlob(null);
    } catch (err) {
      console.error(err);
      toast({
        title: 'Error uploading photos',
        description: err?.message || String(err),
        status: 'error',
        duration: null,
        isClosable: true,
        position: 'top',
      });
    }
  };

  return (
    <Box {...containerProps}>
      <Box {...videoContainerProps}>
        <Box
          as="video"
          ref={videoRef}
          autoPlay
          playsInline
          display={mode === 'camera' ? 'block' : 'none'}
          {...videoProps}
        />
        <Image
          src={previewUrl}
          alt="Preview"
          display={mode === 'preview' ? 'block' : 'none'}
          {...imageProps}
        />
        <Flex {...controlsProps}>
          {mode === 'camera' ? (
            <>
              <Button onClick={handleTake} {...buttonProps}>
                Take Photo
              </Button>
              <Button onClick={handleDone} {...buttonProps}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button onClick={handleRedo} {...buttonProps}>
                Redo
              </Button>
              <Button onClick={handleMore} {...buttonProps}>
                More
              </Button>
              <Button onClick={handleDone} {...buttonProps}>
                Done
              </Button>
            </>
          )}
        </Flex>
      </Box>
    </Box>
  );
}
