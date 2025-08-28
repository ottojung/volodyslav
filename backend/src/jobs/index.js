
const { everyHour, daily, allTasks, scheduleAll, runAllTasks } = require("./all");
const { isDailyTasksUnavailable, ensureDailyTasksAvailable } = require("./daily");

module.exports = {
    everyHour,
    daily,
    allTasks,
    scheduleAll,
    runAllTasks,
    isDailyTasksUnavailable,
    ensureDailyTasksAvailable,
};
