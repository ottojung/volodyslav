#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd -- "${0%/*}"/..

apt-get update -q
apt-get -y -o Dpkg::Options::="--force-confnew" upgrade
apt-get install -y coreutils file nodejs git
uname -a

sh scripts/install "$HOME/.local"
npm test
