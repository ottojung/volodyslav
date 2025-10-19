
FROM termux/termux-docker:aarch64 AS builder
WORKDIR /workspace
COPY . .
RUN chown -R system:system /workspace
CMD ["/bin/sh", "/workspace/scripts/termux-ci-test.sh"]
