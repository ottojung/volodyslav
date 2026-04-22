#! /bin/sh

set -xe

export DEBIAN_FRONTEND=noninteractive

cd -- "${0%/*}"/..

apt-get update -qq
apt-get -qq -y -o Dpkg::Options::="--force-confnew" upgrade
apt-get install -q -y coreutils python build-essential file nodejs git termux-exec

uname -a
id -a
export

export ANDROID_DATA='/data'
export ANDROID_ROOT='/system'
export DEBIAN_FRONTEND='noninteractive'
export HISTCONTROL='ignoreboth'
export HOME='/data/data/com.termux/files/home'
export LANG='en_US.UTF-8'
export LD_PRELOAD='/data/data/com.termux/files/usr/lib/libtermux-exec-ld-preload.so'
export OLDPWD='/workspace'
export PATH='/data/data/com.termux/files/usr/bin'
export PREFIX='/data/data/com.termux/files/usr'
export PWD='/workspace'
export SHELL='/data/data/com.termux/files/usr/bin/bash'
export SHLVL='1'
export TERM='xterm'
export TERMUX_MAIN_PACKAGE_FORMAT='debian'
export TMPDIR='/data/data/com.termux/files/usr/tmp'
export TZ='UTC'
export _='/data/data/com.termux/files/usr/bin/sh'

npm ci
npm run build
npm run test-only
