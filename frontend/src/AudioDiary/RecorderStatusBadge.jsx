import React from "react";
import { Box, Text } from "@chakra-ui/react";

/**
 * @param {{ isRecording: boolean, isPaused: boolean, isStopped: boolean }} props
 * @returns {React.JSX.Element}
 */
export default function RecorderStatusBadge({
    isRecording,
    isPaused,
    isStopped,
}) {
    return (
        <Box textAlign="center">
            <Text
                fontSize="sm"
                fontWeight="semibold"
                color={
                    isRecording
                        ? "red.500"
                        : isPaused
                        ? "yellow.600"
                        : isStopped
                        ? "green.600"
                        : "gray.500"
                }
                textTransform="uppercase"
                letterSpacing="wide"
            >
                {isRecording
                    ? "● Recording"
                    : isPaused
                    ? "⏸ Paused"
                    : isStopped
                    ? "■ Stopped"
                    : "Idle"}
            </Text>
        </Box>
    );
}
