#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd -- "${0%/*}"/..

apt-get update -qq
apt-get -qq -y -o Dpkg::Options::="--force-confnew" upgrade
apt-get install -q -y coreutils python build-essential file nodejs git termux-exec
uname -a
id -a

sh /workspace/scripts/ensure-shebang.sh "$PWD"

npm ci --skip-scripts

sh /workspace/scripts/ensure-shebang.sh "$PWD"

npm ci

npm run build
npm run test-only
