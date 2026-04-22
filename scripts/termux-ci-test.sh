#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd -- "${0%/*}"/..

apt-get update -qq
apt-get -qq -y -o Dpkg::Options::="--force-confnew" upgrade
apt-get install -q -y coreutils file nodejs git
uname -a
id -a

export LD_PRELOAD="${PREFIX}/lib/libtermux-exec-ld-preload.so"

npm ci
npm run build
npm run test-only
