import React, { useState, useEffect } from "react";
import { VStack, Card, Skeleton, HStack, Button } from "@chakra-ui/react";

import { fetchConfig } from "./api.js";
import { CARD_STYLES, SPACING } from "./styles.js";
import { ShortcutsTab } from "./tabs/ShortcutsTab.jsx";
import { HelpTab } from "./tabs/HelpTab.jsx";

/**
 * @typedef {import('./api.js').Config} Config
 * @typedef {import('./api.js').Shortcut} Shortcut
 */

/**
 * @returns {Config|null}
 */
function getInitialConfig() {
    return null;
}

/**
 * Component that displays configuration help and shortcuts
 * @param {Object} props
 * @param {(value: string) => void} props.onShortcutClick - Called when a shortcut is clicked
 * @param {string} props.currentInput - Current input value to show preview
 * @returns {React.JSX.Element|null}
 */
export const ConfigSection = ({ onShortcutClick, currentInput = "" }) => {
    /** @type {[Config|null, import("react").Dispatch<import("react").SetStateAction<Config|null>>]} */
    const configState = useState(getInitialConfig());
    const [config, setConfig] = configState;
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState("help");

    useEffect(() => {
        const loadConfig = async () => {
            setIsLoading(true);
            const configData = await fetchConfig();
            setConfig(configData);
            setIsLoading(false);
        };
        loadConfig();
    }, []);

    if (isLoading) {
        return (
            <Card.Root {...CARD_STYLES.main}>
                <Card.Body p={SPACING.lg}>
                    <VStack gap={SPACING.md}>
                        <Skeleton height="20px" />
                        <Skeleton height="16px" />
                        <Skeleton height="16px" />
                    </VStack>
                </Card.Body>
            </Card.Root>
        );
    }

    if (!config) {
        return null;
    }

    return (
        <Card.Root {...CARD_STYLES.main}>
            <Card.Body p={SPACING.lg}>
                <VStack gap={SPACING.lg} align="stretch">
                    <HStack gap={2}>
                        {config.shortcuts.length > 0 && (
                            <Button
                                size="sm"
                                variant={activeTab === "shortcuts" ? "solid" : "outline"}
                                colorPalette="blue"
                                onClick={() => setActiveTab("shortcuts")}
                            >
                                Shortcuts
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant={activeTab === "help" ? "solid" : "outline"}
                            colorPalette="blue"
                            onClick={() => setActiveTab("help")}
                        >
                            Help
                        </Button>
                    </HStack>

                    {activeTab === "shortcuts" && config.shortcuts.length > 0 ? (
                        <ShortcutsTab
                            shortcuts={config.shortcuts}
                            onShortcutClick={onShortcutClick}
                            currentInput={currentInput}
                        />
                    ) : (
                        <HelpTab
                            helpText={config.help}
                            onShortcutClick={onShortcutClick}
                        />
                    )}
                </VStack>
            </Card.Body>
        </Card.Root>
    );
};
