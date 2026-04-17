
FROM termux/termux-docker:aarch64
USER root
WORKDIR /workspace
COPY . .
# npm-installed Node CLIs expect /usr/bin/env, which Termux does not provide.
RUN mkdir -p /usr/bin \
	&& ln -sf /data/data/com.termux/files/usr/bin/env /usr/bin/env \
	&& chown -R system:system /workspace
USER system
CMD ["sh", "/workspace/scripts/termux-ci-test.sh"]
