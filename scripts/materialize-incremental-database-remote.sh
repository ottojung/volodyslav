#! /bin/sh

set -eu

SOURCE_FIXTURE="$1"
TARGET_REPOSITORY="$2"
HOSTNAME="$3"
BRANCH_NAME="${HOSTNAME}-main"
TMPDIR=$(mktemp -d)
WORKTREE="$TMPDIR/worktree"

cleanup() {
    rm -rf -- "$TMPDIR"
}

trap cleanup EXIT INT TERM

git init --bare -- "$TARGET_REPOSITORY"
git init --initial-branch "$BRANCH_NAME" -- "$WORKTREE"
cp -r -- "$SOURCE_FIXTURE"/. "$WORKTREE"/
git -C "$WORKTREE" add --all
git -C "$WORKTREE" \
    -c user.name=volodyslav \
    -c user.email=volodyslav \
    commit -m "Initial fixture snapshot"
git -C "$WORKTREE" remote add origin -- "$TARGET_REPOSITORY"
git -C "$WORKTREE" push origin "$BRANCH_NAME"