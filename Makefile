
PREFIX = /usr/local

all: install

install:
	sh scripts/update-and-install $(PREFIX)

uninstall:
	sh scripts/uninstall $(PREFIX)

.PHONY: all install uninstall
.SECONDARY:
