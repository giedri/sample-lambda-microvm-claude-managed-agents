# MicroVM image for the Claude self-hosted sandbox worker.
#
# At IMAGE BUILD TIME the worker starts and is snapshotted running.
# At RUN TIME the /run lifecycle hook delivers the session dispatch payload;
# the worker acknowledges, handles the session, then exits.
ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

# Worker runtime dependencies. The Anthropic TypeScript SDK (and the worker's
# engines field) require Node.js >= 22; AL2023's default `nodejs` package is
# 18, so install the versioned nodejs22 package and expose it as `node`/`npm`.
RUN dnf install -y --setopt=install_weak_deps=0 bash unzip tar gzip && \
    (command -v curl >/dev/null 2>&1 || dnf install -y curl) && \
    dnf install -y nodejs22 nodejs22-npm && \
    ln -sf /usr/bin/node-22 /usr/local/bin/node && \
    ln -sf /usr/bin/npm-22 /usr/local/bin/npm && \
    node --version | grep -q "^v22" && \
    dnf clean all

WORKDIR /workspace

# Install the worker package.
COPY worker/package.json /opt/worker/package.json
RUN cd /opt/worker && npm install --omit=dev

COPY worker/worker.mjs /opt/worker/worker.mjs

VOLUME /mnt/session/outputs

# Start the worker at build time so it is captured in the snapshot.
ENTRYPOINT ["node", "/opt/worker/worker.mjs"]
