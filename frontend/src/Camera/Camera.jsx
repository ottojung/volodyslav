import React, { useState, useRef, useEffect, useMemo } from "react";
import { Box, Flex, Button, Image, useToast } from "@chakra-ui/react";
import {
    containerProps,
    videoContainerProps,
    videoProps,
    imageProps,
    controlsProps,
    buttonProps,
} from "./Camera.styles";
import {
    PhotoStorageError,
    PhotoConversionError
} from "../DescriptionEntry/errors.js";

/**
 * @typedef {{ blob: Blob; name: string }} Photo
 */

export default function Camera() {
    const request_identifier = useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get("request_identifier")?.trim() || "";
    }, []);

    const return_to = useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get("return_to")?.trim() || "/";
    }, []);

    const [currentBlob, setCurrentBlob] = useState(
        /** @type {Blob|null} */ (null)
    );
    const [previewUrl, setPreviewUrl] = useState(
        /** @type {string|undefined} */ (undefined)
    );
    const [photos, setPhotos] = useState(/** @type {Photo[]} */ ([]));
    const [mode, setMode] = useState("camera"); // 'camera' or 'preview'
    /** @type {import('react').MutableRefObject<HTMLVideoElement|null>} */
    const videoRef = useRef(null);
    const toast = useToast();

    function checkIdentifier() {
        if (!request_identifier) {
            toast({
                title: "Missing req id",
                description:
                    "Expected a 'request_identifier' query parameter to be passed.",
                status: "error",
                duration: null,
                isClosable: true,
                position: "top",
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
                facingMode: { ideal: "environment" },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
            },
            audio: false,
        };
        navigator.mediaDevices
            .getUserMedia(constraints)
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
                    let title = "Error accessing camera";
                    
                    if (err instanceof Error) {
                        if (err.name === 'NotAllowedError' || err.message.includes('Permission')) {
                            title = "Camera permission denied";
                            description = "Please enable camera permissions in your browser settings and refresh the page.";
                        } else if (err.name === 'NotFoundError' || err.message.includes('device')) {
                            title = "Camera not found";
                            description = "No camera detected on this device. Please ensure your device has a working camera.";
                        } else if (err.name === 'NotSupportedError') {
                            title = "Camera not supported";
                            description = "Your browser doesn't support camera access. Please try a different browser.";
                        } else {
                            description = err.message;
                        }
                    } else {
                        description = String(err);
                    }
                    
                    toast({
                        title,
                        description,
                        status: "error",
                        duration: null,
                        isClosable: true,
                        position: "top",
                    });
                }
            );
        return () => {
            const stream = video.srcObject;
            // Stop all tracks if available
            if (stream && "getTracks" in stream) {
                stream.getTracks().forEach(
                    /** @param {MediaStreamTrack} track */
                    (track) => track.stop()
                );
            }
            // Clean up object URL to prevent memory leak
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
            }
        };
    }, [previewUrl]);

    /**
     * Adds the current blob to the photos list
     * @param {Blob|null} blob
     */
    const addLastPhoto = (blob) => {
        if (blob) {
            const idx = photos.length + 1;
            const index = String(idx).padStart(2, "0");
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
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
            (b) => {
                if (b) {
                    const url = URL.createObjectURL(b);
                    setPreviewUrl(url);
                    setCurrentBlob(b);
                    setMode("preview");
                }
            },
            "image/jpeg",
            1.0
        );
    };

    const resetCamera = () => {
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            setPreviewUrl(undefined);
        }
        setMode("camera");
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
                title: "No photos to upload",
                status: "error",
                duration: 3000,
                isClosable: true,
                position: "top",
            });
            return;
        }

        try {
            // Store photos in sessionStorage for the describe page to retrieve
            const photosData = await Promise.all(
                allPhotos.map(async (photo) => {
                    try {
                        // Convert blob to base64 for storage using FileReader (more reliable)
                        const base64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => {
                                // FileReader gives us a data URL like "data:image/jpeg;base64,..."
                                // We need to extract just the base64 part
                                const result = reader.result;
                                if (typeof result === 'string') {
                                    const base64Data = result.split(',')[1]; // Remove the data URL prefix
                                    resolve(base64Data);
                                } else {
                                    reject(new PhotoConversionError('FileReader did not return a string', photo.name));
                                }
                            };
                            reader.onerror = () => reject(new PhotoConversionError('FileReader failed', photo.name, reader.error));
                            reader.readAsDataURL(photo.blob);
                        });

                        return {
                            name: photo.name,
                            data: base64,
                            type: photo.blob.type || "image/jpeg",
                        };
                    } catch (error) {
                        throw new PhotoConversionError(
                            `Failed to process photo ${photo.name}`,
                            photo.name,
                            error instanceof Error ? error : new Error(String(error))
                        );
                    }
                })
            );

            try {
                sessionStorage.setItem(
                    `photos_${request_identifier}`,
                    JSON.stringify(photosData)
                );
            } catch (storageError) {
                if (storageError instanceof Error && storageError.name === 'QuotaExceededError') {
                    throw new PhotoStorageError(
                        'Not enough storage space. Please free up space and try again.',
                        storageError
                    );
                }
                throw new PhotoStorageError(
                    'Failed to save photos. Please try again.',
                    storageError instanceof Error ? storageError : new Error(String(storageError))
                );
            }

            toast({
                title: "Photos ready",
                status: "success",
                duration: 3000,
                isClosable: true,
                position: "top",
            });
            setPhotos([]);
            setCurrentBlob(null);

            // Navigate back to the originating page with camera info
            const returnUrl = new URL(return_to, window.location.origin);
            returnUrl.searchParams.set("from_camera", "true");
            returnUrl.searchParams.set(
                "request_identifier",
                request_identifier
            );
            window.location.href = returnUrl.toString();
        } catch (/** @type {unknown} */ err) {
            console.error('Camera photo processing error:', err);
            
            let title = "Error processing photos";
            let description = "An unexpected error occurred.";
            
            if (err instanceof PhotoConversionError) {
                title = "Photo conversion failed";
                description = `Failed to process ${err.photoName || 'one or more photos'}. Please try taking new photos.`;
            } else if (err instanceof PhotoStorageError) {
                title = "Storage error";
                description = err.message;
            } else if (err instanceof Error) {
                description = err.message;
            } else {
                description = String(err);
            }
            
            toast({
                title,
                description,
                status: "error",
                duration: null,
                isClosable: true,
                position: "top",
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
                    display={mode === "camera" ? "block" : "none"}
                    {...videoProps}
                />
                <Image
                    src={previewUrl}
                    alt="Preview"
                    display={mode === "preview" ? "block" : "none"}
                    {...imageProps}
                />
                <Flex {...controlsProps}>
                    {mode === "camera" ? (
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
