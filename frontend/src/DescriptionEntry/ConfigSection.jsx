import React, { useState, useEffect } from "react";
import {
    VStack,
    Card,
    CardBody,
    Tabs,
    TabList,
    TabPanels,
    Tab,
    TabPanel,
    Skeleton,
} from "@chakra-ui/react";

import { fetchConfig } from "./api.js";
import { CARD_STYLES, SPACING } from "./styles.js";
import { ShortcutsTab } from "./tabs/ShortcutsTab.jsx";
import { RecentEntriesTab } from "./tabs/RecentEntriesTab.jsx";
import { HelpTab } from "./tabs/HelpTab.jsx";

/**
 * @typedef {import('./api.js').Config} Config
 * @typedef {import('./api.js').Shortcut} Shortcut
 */

/**
 * Component that displays configuration help and shortcuts
 * @param {Object} props
 * @param {(value: string) => void} props.onShortcutClick - Called when a shortcut is clicked
 * @param {string} props.currentInput - Current input value to show preview
 * @param {Array<any>} [props.recentEntries] - Array of recent entries to display
 * @param {boolean} [props.isLoadingEntries] - Whether entries are loading
 */
export const ConfigSection = ({ onShortcutClick, currentInput = "", recentEntries = [], isLoadingEntries = false }) => {
    const [config, setConfig] = useState(/** @type {Config|null} */ (null));
    const [isLoading, setIsLoading] = useState(true);

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
            <Card {...CARD_STYLES.main}>
                <CardBody p={SPACING.lg}>
                    <VStack spacing={SPACING.md}>
                        <Skeleton height="20px" />
                        <Skeleton height="16px" />
                        <Skeleton height="16px" />
                    </VStack>
                </CardBody>
            </Card>
        );
    }

    if (!config) {
        return null;
    }

    return (
        <Card {...CARD_STYLES.main}>
            <CardBody p={SPACING.lg}>
                <VStack spacing={SPACING.lg} align="stretch">
                    <Tabs
                        variant="soft-rounded"
                        colorScheme="blue"
                        defaultIndex={0}
                    >
                        <TabList>
                            <Tab>Recent Entries</Tab>
                            {config.shortcuts.length > 0 && <Tab>Shortcuts</Tab>}
                            <Tab>Help</Tab>
                        </TabList>

                        <TabPanels>
                            <TabPanel px={0}>
                                <RecentEntriesTab 
                                    recentEntries={recentEntries}
                                    isLoadingEntries={isLoadingEntries}
                                    onShortcutClick={onShortcutClick}
                                />
                            </TabPanel>

                            {config.shortcuts.length > 0 && (
                                <TabPanel px={0}>
                                    <ShortcutsTab 
                                        shortcuts={config.shortcuts}
                                        onShortcutClick={onShortcutClick}
                                        currentInput={currentInput}
                                    />
                                </TabPanel>
                            )}

                            <TabPanel px={0}>
                                <HelpTab 
                                    helpText={config.help}
                                    onShortcutClick={onShortcutClick}
                                />
                            </TabPanel>
                        </TabPanels>
                    </Tabs>
                </VStack>
            </CardBody>
        </Card>
    );
};
