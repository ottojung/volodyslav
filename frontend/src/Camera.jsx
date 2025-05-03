import React, { useState, useRef, useEffect } from 'react';
import { Box, Flex, Button, Image, useToast } from '@chakra-ui/react';

export default function Camera() {
    const [currentBlob, setCurrentBlob] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [photos, setPhotos] = useState([]);
    const [mode, setMode] = useState('camera'); // 'camera' or 'preview'
    const videoRef = useRef(null);
    const toast = useToast();

    // Start camera on mount
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

    // Add the current blob to photos list
    /**
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

        // Collect all photos (including current blob if present)
        const allPhotos = currentBlob
              ? [...photos, { blob: currentBlob, name: `photo_${String(photos.length + 1).padStart(2, '0')}.jpg` }]
              : photos;
        if (allPhotos.length === 0) {
            toast({
                title: 'No photos to upload',
                status: 'error',
                duration: null,
                isClosable: true,
                position: 'top',
            });
            return;
        }

        // Prepare form data for upload
        const formData = new FormData();
        allPhotos.forEach((p) => {
            formData.append('photos', p.blob, p.name);
        });

        try {
            // Hardcoded upload endpoint; adjust as needed
            const response = await fetch('/upload', {
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
            // Clear local state
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
        <Box
            as="section"
            position="fixed"
            top={0}
            left={0}
            right={0}
            bottom={0}
            m={0}
            p={0}
            display="flex"
            flexDirection="column"
            bg="black"
            color="white"
            fontFamily="sans-serif"
            overflow="hidden"
        >
            <Box position="relative" flex={1} w="100%" overflow="hidden">
                <Box
                    as="video"
                    ref={videoRef}
                    autoPlay
                    playsInline
                    display={mode === 'camera' ? 'block' : 'none'}
                    w="100%"
                    h="100%"
                    objectFit="cover"
                    bg="black"
                />
                <Image
                    src={previewUrl}
                    alt="Preview"
                    display={mode === 'preview' ? 'block' : 'none'}
                    w="100%"
                    h="100%"
                    objectFit="cover"
                    bg="black"
                />
                <Flex
                    position="absolute"
                    bottom="20px"
                    left="50%"
                    transform="translateX(-50%)"
                    gap="0.5em"
                    px="0.5em"
                    flexWrap="wrap"
                    boxSizing="border-box"
                >
                    {mode === 'camera' ? (
                        <>
                            <Button
                                onClick={handleTake}
                                bg="rgba(255,255,255,0.2)"
                                color="white"
                                borderRadius="5px"
                                px="1.6em"
                                py="0.8em"
                                fontSize="1rem"
                            >
                                Take Photo
                            </Button>
                            <Button
                                onClick={handleDone}
                                bg="rgba(255,255,255,0.2)"
                                color="white"
                                borderRadius="5px"
                                px="1.6em"
                                py="0.8em"
                                fontSize="1rem"
                            >
                                Done
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                onClick={handleRedo}
                                bg="rgba(255,255,255,0.2)"
                                color="white"
                                borderRadius="5px"
                                px="1.6em"
                                py="0.8em"
                                fontSize="1rem"
                            >
                                Redo
                            </Button>
                            <Button
                                onClick={handleMore}
                                bg="rgba(255,255,255,0.2)"
                                color="white"
                                borderRadius="5px"
                                px="1.6em"
                                py="0.8em"
                                fontSize="1rem"
                            >
                                More
                            </Button>
                            <Button
                                onClick={handleDone}
                                bg="rgba(255,255,255,0.2)"
                                color="white"
                                borderRadius="5px"
                                px="1.6em"
                                py="0.8em"
                                fontSize="1rem"
                            >
                                Done
                            </Button>
                        </>
                    )}
                </Flex>
            </Box>
        </Box>
    );
}
