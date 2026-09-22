FROM code.forgejo.org/forgejo/runner:13.2.0@sha256:ca3d5eea46004789a175d1369eec6829d3ea9bfbe2011a06625b4bdaa55f7552

# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=12.5.1
# renovate: datasource=npm depName=renovate
ARG RENOVATE_VERSION=44.103.2

# Host mode runs workflow steps in this image itself, so the toolchain the
# workflows need has to be baked in rather than pulled per job.
USER root
# netavark: buildah looks for it before every build, even with --network=host.
RUN apk add --no-cache nodejs npm curl buildah netavark \
 && npm install -g "pnpm@${PNPM_VERSION}" "renovate@${RENOVATE_VERSION}" \
 && npm cache clean --force
USER 1000
