import { useState, useRef, useEffect } from "react";
import { useToast } from "@chakra-ui/react";
import {
    PhotoStorageError,
    PhotoConversionError,
} from "../DescriptionEntry/errors.js";
import { processPhotos } from "./process_photos.js";

/**
 * @typedef {{ blob: Blob; name: string }} Photo
 */

/**
 * Camera logic hook handling state and photo actions.
 * @param {string} requestIdentifier
 * @param {string} returnTo
 * @returns {{
 *  videoRef: import('react').MutableRefObject<HTMLVideoElement|null>,
 *  previewUrl: string|undefined,
 *  mode: string,
 *  handleTake: () => void,
 *  handleMore: () => void,
 *  handleRedo: () => void,
 *  handleDone: () => Promise<void>,
 * }}
 */
export function useCameraLogic(requestIdentifier, returnTo) {
    const [currentBlob, setCurrentBlob] = useState(/** @type {Blob|null} */ (null));
    const [previewUrl, setPreviewUrl] = useState(/** @type {string|undefined} */ (undefined));
    const [photos, setPhotos] = useState(/** @type {Photo[]} */ ([]));
    const [mode, setMode] = useState("camera");
    /** @type {import('react').MutableRefObject<HTMLVideoElement|null>} */
    const videoRef = useRef(null);
    const toast = useToast();

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
                },
            );
        return () => {
            const stream = video.srcObject;
            if (stream && "getTracks" in stream) {
                stream.getTracks().forEach(
                    /** @param {MediaStreamTrack} track */
                    (track) => track.stop(),
                );
            }
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
            }
        };
    }, [previewUrl]);

    /**
     * @param {Blob|null} blob
     * @returns {Photo[]}
     */
    const addLastPhoto = (blob) => {
        if (blob) {
            const idx = photos.length + 1;
            const index = String(idx).padStart(2, "0");
            const name = `photo_${index}.jpeg`;
            const allPhotos = [...photos, { blob, name }];
            setPhotos(() => allPhotos);
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
            1.0,
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
            await processPhotos(
                allPhotos,
                requestIdentifier,
                returnTo,
                (url) => {
                    window.location.href = url;
                },
            );

            toast({
                title: "Photos ready",
                status: "success",
                duration: 3000,
                isClosable: true,
                position: "top",
            });
            setPhotos([]);
            setCurrentBlob(null);

        } catch (/** @type {unknown} */ err) {
            console.error("Camera photo processing error:", err);

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
}
