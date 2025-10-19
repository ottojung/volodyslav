#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd /workspace
apt update -q
apt install -y coreutils file
uname -a
