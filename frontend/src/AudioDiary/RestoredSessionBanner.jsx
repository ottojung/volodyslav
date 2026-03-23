import React from "react";
import { Alert, Box } from "@chakra-ui/react";

/**
 * @param {{ hasRestoredSession: boolean }} props
 * @returns {React.JSX.Element | null}
 */
export default function RestoredSessionBanner({ hasRestoredSession }) {
    if (!hasRestoredSession) {
        return null;
    }
    return (
        <Alert.Root status="info" borderRadius="md" data-testid="restored-session-banner">
            <Alert.Indicator />
            <Box>
                <Alert.Title>Session Restored</Alert.Title>
                <Alert.Description>
                    Your previous recording session was restored.
                </Alert.Description>
            </Box>
        </Alert.Root>
    );
}
