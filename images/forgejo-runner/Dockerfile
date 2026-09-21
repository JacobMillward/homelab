FROM code.forgejo.org/forgejo/runner:13.2.0@sha256:ca3d5eea46004789a175d1369eec6829d3ea9bfbe2011a06625b4bdaa55f7552

# Host mode runs workflow steps in this image itself, so the toolchain the
# workflows need has to be baked in rather than pulled per job.
USER root
RUN apk add --no-cache nodejs npm curl \
 && npm install -g pnpm@12 renovate@44.101.2 \
 && npm cache clean --force
USER 1000
