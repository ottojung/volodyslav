
class CommandUnavailable extends Error {
    /** @type {string} */
    command;

    /**
     * @param {string} command - The command that is unavailable.
     */
    constructor(command) {
        super(
            `Command ${command} unavailable, its executable not found in $PATH. Please ensure that respective program is installed and available in your $PATH.`
        );
        this.command = command;
    }
}

module.exports = { CommandUnavailable };
