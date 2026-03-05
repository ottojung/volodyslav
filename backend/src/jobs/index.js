
const { everyHour, daily, allTasks, scheduleAll, runAllTasks } = require("./all");
const { isDailyTasksUnavailable, ensureDailyTasksAvailable, executeDailyTasks } = require("./daily");

module.exports = {
    everyHour,
    daily,
    allTasks,
    scheduleAll,
    runAllTasks,
    isDailyTasksUnavailable,
    ensureDailyTasksAvailable,
    executeDailyTasks,
};
