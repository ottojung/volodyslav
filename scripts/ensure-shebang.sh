#! /bin/sh

if test "$#" -ne 1
then
    echo "Usage: $0 TARGET" >&2
    echo 'Ensures that the directory at `TARGET` has a shebang line.' >&2
    exit 1
fi

TARGET="$1"
if ! test -d "$TARGET"
then
    echo "Error: $TARGET is not a directory." >&2
    exit 1
fi

set -xe

SH_PATH="$(command -v sh)"
ENV_PATH="$(command -v env)"

find -- "$TARGET" -type f -executable -exec sed -i "s@^#!.?/bin/sh@#! $SH_PATH@" {} +
find -- "$TARGET" -type f -executable -exec sed -i "s@^#!.?/usr/bin/env@#! $ENV_PATH@" {} +
