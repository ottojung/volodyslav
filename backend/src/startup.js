const { ensureNotificationsAvailable } = require('./notifications');

async function ensureStartupDependencies() {
    await ensureNotificationsAvailable();
}

module.exports = {
    ensureStartupDependencies,
};
