import React from "react";

// Simple icon components using forwardRef to avoid warnings
export const ChevronDownIcon = React.forwardRef((props, ref) => (
    <span ref={ref} {...props}>
        ▼
    </span>
));
ChevronDownIcon.displayName = "ChevronDownIcon";

export const ChevronUpIcon = React.forwardRef((props, ref) => (
    <span ref={ref} {...props}>
        ▲
    </span>
));
ChevronUpIcon.displayName = "ChevronUpIcon";

export const InfoIcon = React.forwardRef((props, ref) => (
    <span ref={ref} {...props}>
        ℹ️
    </span>
));
InfoIcon.displayName = "InfoIcon";
