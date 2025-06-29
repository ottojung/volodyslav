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

    const return_to = useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('return_to')?.trim() || '/';
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

        try {
            // Store photos in sessionStorage for the describe page to retrieve
            const photosData = await Promise.all(
                allPhotos.map(async (photo) => {
                    // Convert blob to base64 for storage using a more memory-efficient approach
                    const arrayBuffer = await photo.blob.arrayBuffer();
                    const uint8Array = new Uint8Array(arrayBuffer);
                    
                    // Convert to base64 in chunks to avoid stack overflow
                    let base64 = '';
                    const chunkSize = 8192; // Process in 8KB chunks
                    for (let i = 0; i < uint8Array.length; i += chunkSize) {
                        const chunk = uint8Array.subarray(i, i + chunkSize);
                        base64 += btoa(String.fromCharCode.apply(null, Array.from(chunk)));
                    }
                    
                    return {
                        name: photo.name,
                        data: base64,
                        type: photo.blob.type || 'image/jpeg'
                    };
                })
            );
            
            // Store with request identifier as key
            sessionStorage.setItem(`photos_${request_identifier}`, JSON.stringify(photosData));
            
            toast({
                title: 'Photos ready',
                status: 'success',
                duration: 3000,
                isClosable: true,
                position: 'top',
            });
            setPhotos([]);
            setCurrentBlob(null);
            
            // Navigate back to the originating page with camera info
            const returnUrl = new URL(return_to, window.location.origin);
            returnUrl.searchParams.set('from_camera', 'true');
            returnUrl.searchParams.set('request_identifier', request_identifier);
            window.location.href = returnUrl.toString();
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
