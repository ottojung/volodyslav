const { registerCommand } = require("./subprocess");

const termuxNotification = registerCommand('termux-notification');
const git = registerCommand('git');
const volodyslavDailyTasks = registerCommand('volodyslav-daily-tasks');

module.exports = {
    termuxNotification,
    git,
    volodyslavDailyTasks,
};
