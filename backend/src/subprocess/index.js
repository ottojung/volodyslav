
const { registerCommand } = require('./command');
const { isCommandUnavailable } = require('./resolve_executable_path');

module.exports = {
    registerCommand,
    isCommandUnavailable,
};
