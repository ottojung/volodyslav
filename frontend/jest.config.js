// Jest configuration for frontend project
module.exports = {
    displayName: "frontend",
    testEnvironment: "jsdom",
    transform: {
        "^.+[.][jt]sx?$": "babel-jest",
    },
    moduleFileExtensions: ["js", "jsx", "json", "node"],
    setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
};
