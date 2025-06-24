// Main component export
export { default } from "./DescriptionEntry.jsx";

// Individual component exports for testing or reuse
export { EntryItem, EntryItemSkeleton } from "./EntryItem.jsx";
export { FormInputSection } from "./FormInputSection.jsx";
export { RecentEntriesSection } from "./RecentEntriesSection.jsx";

// Utilities and hooks
export { useDescriptionEntry } from "./hooks.js";
export { formatRelativeDate, isValidDescription, createToastConfig } from "./utils.js";
export * from "./styles.js";
