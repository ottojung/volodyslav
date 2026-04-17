#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd -- "${0%/*}"/..

apt-get update -qq
apt-get -qq -y -o Dpkg::Options::="--force-confnew" upgrade
apt-get install -q -y coreutils python build-essential file nodejs git
uname -a
id -a

export PATH="$PWD/node_modules/.bin:$PWD/backend/node_modules/.bin:$PATH"
npm ci
npm run build
npm run test-only
