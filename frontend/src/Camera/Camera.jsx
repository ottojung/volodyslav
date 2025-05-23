import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Box, Flex, Button, Image, useToast } from '@chakra-ui/react';
import {
    containerProps,
    videoContainerProps,
    videoProps,
    imageProps,
    controlsProps,
    buttonProps,
} from './Camera.styles';

/**
 * @typedef {{ blob: Blob; name: string }} Photo
 */


export default function Camera() {
    const request_identifier = useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('request_identifier')?.trim() || '';
    }, []);

    const [currentBlob, setCurrentBlob] = useState(/** @type {Blob|null} */ (null));
    const [previewUrl, setPreviewUrl] = useState(/** @type {string|undefined} */ (undefined));
    const [photos, setPhotos] = useState(/** @type {Photo[]} */ ([]));
    const [mode, setMode] = useState('camera'); // 'camera' or 'preview'
    /** @type {import('react').MutableRefObject<HTMLVideoElement|null>} */
    const videoRef = useRef(null);
    const toast = useToast();

    function checkIdentifier() {
        if (!request_identifier) {
            toast({
                title: 'Missing req id',
                description: "Expected a 'request_identifier' query parameter to be passed.",
                status: 'error',
                duration: null,
                isClosable: true,
                position: 'top',
            });
            return false;
        } else {
            return true;
        }
    }

    useEffect(() => {
        if (!checkIdentifier()) {
            return;
        }

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
            .catch(
                /**
                 * @param {unknown} err
                 */
                (err) => {
                    let description;
                    if (err instanceof Object && 'message' in err) {
                        description = String(err.message);
                    } else {
                        description = String(err);
                    }
                    toast({
                        title: 'Error accessing camera',
                        description: description,
                        status: 'error',
                        duration: null,
                        isClosable: true,
                        position: 'top',
                    });
                });
        return () => {
            const stream = video.srcObject;
            // Stop all tracks if available
            if (stream && 'getTracks' in stream) {
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
            const idx = photos.length + 1;
            const index = String(idx).padStart(2, '0');
            const name = `photo_${index}.jpeg`;
            const allPhotos = [...photos, { blob, name }];
            setPhotos((_prev) => allPhotos);
            setCurrentBlob(null);
            return allPhotos;
        }
        return photos;
    };

    const handleTake = () => {
        const video = videoRef.current;
        if (!video) return;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
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
            setPreviewUrl(undefined);
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
        const allPhotos = addLastPhoto(currentBlob);
        resetCamera();

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

        const url = new URL('/api/upload', window.location.origin);
        url.searchParams.set('request_identifier', request_identifier);
        const formData = new FormData();
        allPhotos.forEach((p) => {
            formData.append('photos', p.blob, p.name);
        });

        try {
            const response = await fetch(url, {
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
        } catch (/** @type {unknown} */ err) {
            console.error(err);
            let description;
            if (err instanceof Error) {
                description = err.message;
            } else {
                description = String(err);
            }
            toast({
                title: 'Error uploading photos',
                description: description,
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
