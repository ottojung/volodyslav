/**
 * Generates badge text for the ConfigSection header
 * @param {number} shortcutsCount - Number of shortcuts
 * @param {number} recentEntriesCount - Number of recent entries
 * @returns {string} - Formatted badge text
 */
export const generateBadgeText = (shortcutsCount, recentEntriesCount) => {
    return [
        shortcutsCount > 0 && `${shortcutsCount} shortcuts`,
        recentEntriesCount > 0 && `${recentEntriesCount} recent`
    ].filter(Boolean).join(" • ");
};
