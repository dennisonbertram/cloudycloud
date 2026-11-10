FROM node:22-bookworm-slim

ARG VERSION=dev
ARG CLAUDE_CODE_VERSION=2.1.322
ARG UV_VERSION=0.5.14

# coreutils (timeout, base64) is already in the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux curl ca-certificates python3 openssh-client gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# The base image's "node" user holds uid 1000; replace it with "worker".
RUN userdel -r node && useradd -m -u 1000 -s /bin/bash worker

LABEL cloudy-cloud.image=${VERSION}
USER worker
WORKDIR /home/worker
