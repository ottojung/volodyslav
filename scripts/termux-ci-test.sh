#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd /workspace
apt-get update -q
apt-get -y -o Dpkg::Options::="--force-confnew" upgrade
apt-get install -y coreutils file node git
uname -a
