
FROM termux/termux-docker:aarch64
RUN apt-get update -qq
RUN apt-get install -y coreutils python build-essential file nodejs git termux-exec rsync
WORKDIR /workspace
COPY . .
RUN chown -R system:system /workspace
CMD ["bash", "-il", "/workspace/scripts/termux-ci-test.sh"]
