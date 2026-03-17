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
    export VOLODYSLAV_GENERATORS_REPOSITORY="dist/test/mock-generators-repository"
    if ! test -d "$VOLODYSLAV_GENERATORS_REPOSITORY"
    then
        mkdir -p -- "$VOLODYSLAV_GENERATORS_REPOSITORY"
        git -C "$VOLODYSLAV_GENERATORS_REPOSITORY" init --initial-branch=master
        git -C "$VOLODYSLAV_GENERATORS_REPOSITORY" -c user.name=volodyslav -c user.email=volodyslav commit --allow-empty -m "Initial empty commit"
        git -C "$VOLODYSLAV_GENERATORS_REPOSITORY" config receive.denyCurrentBranch ignore
    fi
fi
