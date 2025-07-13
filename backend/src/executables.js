const { registerCommand } = require("./subprocess");

const termuxNotification = registerCommand('termux-notification');
const termuxWifiCommand = registerCommand('termux-wifi-connectioninfo');
const git = registerCommand('git');
const volodyslav_daily_tasks = registerCommand('volodyslav-daily-tasks');

module.exports = {
    termuxNotification,
    termuxWifiCommand,
    git,
    volodyslav_daily_tasks,
};
