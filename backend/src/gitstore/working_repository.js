

//
// This modules provides definitions and methods 
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const environment = require("../environment");
const path = require("path");

function pathToLocalRepository() {
    const wd = environment.workingDirectory();
    return path.join(wd, "working-git-repository");
}

function synchronize() {
    // TODO: clone or pull the repository from `environment.eventLogRepository()` to `pathToLocalRepository()`.
}


function getRepository() {
    // TODO:    
    // return path to the local git repository, but ensure that it exists first.
}

module.exports = {
    synchronize,
    getRepository,
};
