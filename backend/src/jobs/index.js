
const { everyHour, daily, allTasks, scheduleAll, runAllTasks } = require("./all");
const { isDailyTasksUnavailable, ensureDailyTasksAvailable, executeDailyTasks } = require("./daily");
const { computeAllCalories } = require("./calories");

module.exports = {
    everyHour,
    daily,
    allTasks,
    scheduleAll,
    runAllTasks,
    isDailyTasksUnavailable,
    ensureDailyTasksAvailable,
    executeDailyTasks,
    computeAllCalories,
};
