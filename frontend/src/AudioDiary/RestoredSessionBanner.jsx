import React from "react";
import { Alert, AlertIcon, AlertTitle, AlertDescription, Box } from "@chakra-ui/react";

/**
 * @param {{ hasRestoredSession: boolean }} props
 * @returns {React.JSX.Element | null}
 */
export default function RestoredSessionBanner({ hasRestoredSession }) {
    if (!hasRestoredSession) {
        return null;
    }
    return (
        <Alert status="info" borderRadius="md" data-testid="restored-session-banner">
            <AlertIcon />
            <Box>
                <AlertTitle>Session Restored</AlertTitle>
                <AlertDescription>
                    Your previous recording session was restored.
                </AlertDescription>
            </Box>
        </Alert>
    );
}
