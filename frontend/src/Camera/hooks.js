/**
 * Camera state and actions
 */

import { useState, useRef, useEffect } from "react";
import { useToast } from "@chakra-ui/react";
import { logger } from "../DescriptionEntry/logger.js";
import {
    PhotoStorageError,
    PhotoConversionError,
} from "../DescriptionEntry/errors.js";

/**
 * @typedef {{ blob: Blob; name: string }} Photo
 */

/**
 * Hook for camera logic
 * @param {string} requestIdentifier
 * @param {string} returnTo
 * @returns {{
 *   videoRef: import('react').MutableRefObject<HTMLVideoElement|null>,
 *   previewUrl: string|undefined,
 *   mode: string,
 *   handleTake: () => void,
 *   handleMore: () => void,
 *   handleRedo: () => void,
 *   handleDone: () => Promise<void>
 * }} Camera utilities
 */
export const useCamera = (requestIdentifier, returnTo) => {
    const [currentBlob, setCurrentBlob] = useState(/** @type {Blob|null} */ (null));
    const [previewUrl, setPreviewUrl] = useState(/** @type {string|undefined} */ (undefined));
    const [photos, setPhotos] = useState(/** @type {Photo[]} */ ([]));
    const [mode, setMode] = useState("camera");
    /** @type {import('react').MutableRefObject<HTMLVideoElement|null>} */
    const videoRef = useRef(null);
    const toast = useToast();

    /**
     * Validate that a request identifier was provided.
     * @returns {boolean} True if an identifier is present, false otherwise.
     */
    function checkIdentifier() {
        if (!requestIdentifier) {
            toast({
                title: "Missing req id",
                description: "Expected a 'request_identifier' query parameter to be passed.",
                status: "error",
                duration: null,
                isClosable: true,
                position: "top",
            });
            return false;
        }
        return true;
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
                        if (err.name === "NotAllowedError" || err.message.includes("Permission")) {
                            title = "Camera permission denied";
                            description = "Please enable camera permissions in your browser settings and refresh the page.";
                        } else if (err.name === "NotFoundError" || err.message.includes("device")) {
                            title = "Camera not found";
                            description = "No camera detected on this device. Please ensure your device has a working camera.";
                        } else if (err.name === "NotSupportedError") {
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
            if (stream && "getTracks" in stream) {
                stream.getTracks().forEach(
                    /** @param {MediaStreamTrack} track */
                    (track) => track.stop()
                );
            }
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
            }
        };
    }, [previewUrl]);

    /**
     * Adds the provided blob to the photo list if present.
     * @param {Blob|null} blob
     * @returns {Photo[]} Updated photo list
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

    /**
     * Capture a photo from the video stream and prepare a preview.
     * @returns {void}
     */
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

    /**
     * Reset preview state and return to camera mode.
     * @returns {void}
     */
    const resetCamera = () => {
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            setPreviewUrl(undefined);
        }
        setMode("camera");
    };

    /**
     * Save the current photo and prepare for the next one.
     * @returns {void}
     */
    const handleMore = () => {
        addLastPhoto(currentBlob);
        resetCamera();
    };

    /**
     * Discard the current photo and reset the camera.
     * @returns {void}
     */
    const handleRedo = () => {
        setCurrentBlob(null);
        resetCamera();
    };

    /**
     * Finalize photo capture and store all photos.
     * @returns {Promise<void>}
     */
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
            const photosData = await Promise.all(
                allPhotos.map(async (photo) => {
                    try {
                        const base64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => {
                                const result = reader.result;
                                if (typeof result === "string") {
                                    const base64Data = result.split(",")[1];
                                    resolve(base64Data);
                                } else {
                                    reject(new PhotoConversionError("FileReader did not return a string", photo.name));
                                }
                            };
                            reader.onerror = () =>
                                reject(new PhotoConversionError("FileReader failed", photo.name, reader.error));
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
                sessionStorage.setItem(`photos_${requestIdentifier}`, JSON.stringify(photosData));
            } catch (storageError) {
                if (storageError instanceof Error && storageError.name === "QuotaExceededError") {
                    throw new PhotoStorageError(
                        "Not enough storage space. Please free up space and try again.",
                        storageError
                    );
                }
                throw new PhotoStorageError(
                    "Failed to save photos. Please try again.",
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

            const returnUrl = new URL(returnTo, window.location.origin);
            returnUrl.searchParams.set("from_camera", "true");
            returnUrl.searchParams.set("request_identifier", requestIdentifier);
            window.location.href = returnUrl.toString();
        } catch (/** @type {unknown} */ err) {
            logger.error("Camera photo processing error:", err);

            let title = "Error processing photos";
            let description = "An unexpected error occurred.";

            if (err instanceof PhotoConversionError) {
                title = "Photo conversion failed";
                description = `Failed to process ${err.photoName || "one or more photos"}. Please try taking new photos.`;
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

    return {
        videoRef,
        previewUrl,
        mode,
        handleTake,
        handleMore,
        handleRedo,
        handleDone,
    };
};

