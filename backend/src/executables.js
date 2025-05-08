const { registerCommand } = require("./subprocess");

const termuxNotification = registerCommand('termux-notification');

module.exports = {
    termuxNotification,
}
