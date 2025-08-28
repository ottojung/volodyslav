
const { everyHour, daily, allTasks, scheduleAll, runAllTasks } = require("./all");
const { isDailyTasksUnavailable } = require("./daily");

module.exports = {
    everyHour,
    daily,
    allTasks,
    scheduleAll,
    runAllTasks,
    isDailyTasksUnavailable,
};
