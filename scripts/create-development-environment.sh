#! /bin/sh

export VOLODYSLAV_LOG_LEVEL="info"
export VOLODYSLAV_OPENAI_API_KEY="$OPENAI_API_KEY"
export VOLODYSLAV_WORKING_DIRECTORY="dist/test/wd"
export VOLODYSLAV_DIARY_RECORDINGS_DIRECTORY="dist/test/recordings"
export VOLODYSLAV_EVENT_LOG_ASSETS_DIRECTORY="dist/test/event-log-assets"
export VOLODYSLAV_EVENT_LOG_ASSETS_REPOSITORY="dist/test/mock-event-log-assets-repository"
export VOLODYSLAV_SERVER_PORT=3000
export VOLODYSLAV_HOSTNAME="${VOLODYSLAV_HOSTNAME:-$(hostname)}"

if test -z "$VOLODYSLAV_GENERATORS_REPOSITORY"
then
    if test "$VOLODYSLAV_USE_EMPTY_INCREMENTAL_DATABASE_REMOTE" = "1"
    then
        export VOLODYSLAV_GENERATORS_REPOSITORY="dist/test/mock-incremental-database-remote"
        SOURCE_REMOTE_FIXTURE="backend/tests/mock-incremental-database-remote"
    else
        export VOLODYSLAV_GENERATORS_REPOSITORY="dist/test/mock-incremental-database-remote-populated"
        SOURCE_REMOTE_FIXTURE="backend/tests/mock-incremental-database-remote-populated"
    fi

    if ! test -d "$VOLODYSLAV_GENERATORS_REPOSITORY"
    then
        mkdir -p -- dist/test
        sh scripts/materialize-incremental-database-remote.sh \
            "$SOURCE_REMOTE_FIXTURE" \
            "$VOLODYSLAV_GENERATORS_REPOSITORY" \
            "$VOLODYSLAV_HOSTNAME"
    fi
fi
