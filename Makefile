
PREFIX = /usr/local

all: install

install:
	sh scripts/update-and-install $(PREFIX)

.PHONY: all install
.SECONDARY:
