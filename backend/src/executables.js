const { registerCommand } = require("./subprocess");

const termuxNotification = registerCommand('termux-notification');
const git = registerCommand('git');

module.exports = {
    termuxNotification,
    git,
};
