
FROM termux/termux-docker:aarch64
WORKDIR /workspace
COPY . .
RUN chown -R system:system /workspace
CMD ["sh", "/workspace/scripts/termux-ci-test.sh"]
