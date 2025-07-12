const { registerCommand } = require("./subprocess");

const termuxNotification = registerCommand('termux-notification');
const termuxWifiCommand = registerCommand('termux-wifi-connectioninfo');
const git = registerCommand('git');

module.exports = {
    termuxNotification,
    termuxWifiCommand,
    git,
};
