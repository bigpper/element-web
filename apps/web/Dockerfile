# syntax=docker.io/docker/dockerfile:1.25-labs@sha256:4426b5e269e36911b94fb79cf67f1fd7155ef11b2bbc8ab23cbfcbc97130efe9
# Context must be the root of the monorepo

# PNPM source
FROM --platform=$BUILDPLATFORM ghcr.io/pnpm/pnpm:11.10.0@sha256:9a6eb06d5f861d830fe27d85a91415e60527fa45ec45b52ee43c92a8aaf3bf8a AS pnpm

# Builder
FROM --platform=$BUILDPLATFORM node:24-bullseye@sha256:384bd20e0a4bf604dbffb5aca24ad4eb54dbd078a500a6cb65259ebc42afd5a2 AS builder

COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm

# Support custom branch of the js-sdk. This also helps us build images of element-web develop.
ARG USE_CUSTOM_SDKS=false
ARG JS_SDK_REPO="https://github.com/matrix-org/matrix-js-sdk.git"
ARG JS_SDK_BRANCH="master"

WORKDIR /src

# Install dependencies
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml patches scripts **/package.json /src/
# COMPANY PATCH — build infrastructure only, no effect on the produced app.
# The default 60s fetch timeout is not survivable on a slow link to
# registry.npmjs.org: this install pulls ~2400 packages and died with
# "TimeoutError: The operation was aborted due to timeout" after 8m of
# sub-50 KiB/s downloads. Timeout and retries raised; the registry is
# deliberately NOT changed — routing the dependency tree through a third-party
# mirror is a supply-chain decision, not a speed tweak, and this Dockerfile
# runs supply-chain policy checks on the lockfile for a reason.
RUN pnpm install --frozen-lockfile \
    --fetch-timeout 600000 \
    --fetch-retries 5 \
    --fetch-retry-maxtimeout 120000
RUN --mount=type=bind,source=.git,target=/src/.git /src/scripts/docker-link-repos.sh

# Build
COPY --link --exclude=.git --exclude=apps/web/docker . /src
RUN --mount=type=bind,source=.git,target=/src/.git /src/scripts/docker-package.sh

# Copy the config now so that we don't create another layer in the app image
RUN cp /src/apps/web/config.sample.json /src/apps/web/webapp/config.json

# App
FROM nginxinc/nginx-unprivileged:alpine-slim@sha256:d9fa63891743a11eb56ca1b22d8cc227491df183ca3da2cf1bf2c6e010bf19a5

# Need root user to install packages & manipulate the usr directory
USER root

# Install jq and moreutils for sponge, both used by our entrypoints
RUN apk add jq moreutils

COPY --from=builder /src/apps/web/webapp /app

# Override default nginx config. Templates in `/etc/nginx/templates` are passed
# through `envsubst` by the nginx docker image entry point.
COPY /apps/web/docker/nginx-templates/* /etc/nginx/templates/
COPY /apps/web/docker/docker-entrypoint.d/* /docker-entrypoint.d/

RUN rm -rf /usr/share/nginx/html \
  && ln -s /app /usr/share/nginx/html

# Run as nginx user by default
USER nginx

# HTTP listen port
ENV ELEMENT_WEB_PORT=80

HEALTHCHECK --start-period=5s CMD wget -q --spider http://localhost:$ELEMENT_WEB_PORT/config.json
