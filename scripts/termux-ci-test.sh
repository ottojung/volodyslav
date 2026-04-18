#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd -- "${0%/*}"/..

apt-get update -qq
apt-get -qq -y -o Dpkg::Options::="--force-confnew" upgrade
# Use nodejs-lts instead of nodejs (current in Termux is Node 25), because
# npm bundled with the cutting-edge channel intermittently fails to expose
# transitive lifecycle binaries (e.g. node-gyp-build) during npm ci.
apt-get install -q -y coreutils file nodejs-lts git
uname -a
id -a
node --version
npm --version

npm ci
npm run build
npm run test-only
