
PREFIX = /usr/local

all: install

install: build/packages-token
	sh scripts/install-post-npm $(PREFIX)

build/packages-token: package.json package-lock.json backend/package.json frontend/package.json
	npm ci
	mkdir -p -- build/
	touch "$@"

uninstall:
	sh scripts/uninstall $(PREFIX)

.PHONY: all install uninstall
.SECONDARY:
