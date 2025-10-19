#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd /workspace
apt-get update -q
apt-get install -y coreutils file | cat
uname -a
