
FROM termux/termux-docker:aarch64
WORKDIR /workspace
COPY . .
RUN chown -R system:system /workspace
RUN sh /workspace/scripts/ensure-shebang.sh /workspace
CMD ["sh", "/workspace/scripts/termux-ci-test.sh"]
