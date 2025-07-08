import React, { useMemo } from "react";
import { Box, Flex, Button, Image } from "@chakra-ui/react";
import {
    containerProps,
    videoContainerProps,
    videoProps,
    imageProps,
    controlsProps,
    buttonProps,
} from "./Camera.styles";
import { useCameraLogic } from "./camera_logic.js";

/**
 * @typedef {{ blob: Blob; name: string }} Photo
 */

/**
 * Camera component allowing users to capture photos and
 * navigate back to the main application once done.
 *
 * @returns {JSX.Element}
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

    const {
        videoRef,
        previewUrl,
        mode,
        handleTake,
        handleMore,
        handleRedo,
        handleDone,
    } = useCameraLogic(request_identifier, return_to);

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
