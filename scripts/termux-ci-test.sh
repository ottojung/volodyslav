#! /bin/sh

set -xe

cd /workspace
apt update -q
apt install -y coreutils file
uname -a
