# renovate: datasource=github-releases depName=crowdsecurity/cs-firewall-bouncer
ARG BOUNCER_VERSION=v0.0.36

FROM golang:1.25-alpine AS builder
RUN apk add --no-cache git
WORKDIR /src
ARG BOUNCER_VERSION
RUN git clone --branch ${BOUNCER_VERSION} --depth 1 https://github.com/crowdsecurity/cs-firewall-bouncer.git .
RUN CGO_ENABLED=0 go build \
      -ldflags "-s -extldflags '-static' -X 'github.com/crowdsecurity/go-cs-lib/version.Version=${BOUNCER_VERSION}'" \
      -trimpath -tags netgo \
      -o /cs-firewall-bouncer .

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache ca-certificates
COPY --from=builder /cs-firewall-bouncer /usr/local/bin/cs-firewall-bouncer
ENTRYPOINT ["/usr/local/bin/cs-firewall-bouncer"]
