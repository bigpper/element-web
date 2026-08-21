#!/usr/bin/env bash

set -ex

BRANCH=$(git rev-parse --abbrev-ref HEAD)

DIR=$(dirname "$0")

# If the branch comes out as HEAD then we're probably checked out to a tag, so if the thing is *not*
# coming out as HEAD then we're on a branch. When we're on a branch, we want to resolve ourselves to
# a few SHAs rather than a version.
# COMPANY PATCH — build infrastructure only, no effect on the produced app.
#
# get-version-from-git.sh derives the version by rev-parsing a matrix-js-sdk *git
# checkout*, which only exists on `develop`, where the SDK is linked from source. Our
# fork is release v1.12.25 plus company commits on a named branch, so the branch test
# alone sends us down the develop path and the build dies with
#
#   fatal: cannot change to '/src/node_modules/matrix-js-sdk': No such file or directory
#
# This was latent: the step is cached, so it only surfaced when a source change first
# invalidated the layer. Require the checkout to actually be there, and otherwise take
# the same tag description a release checkout would have produced.
if [[ $BRANCH != HEAD && ! $BRANCH =~ heads/v.+ ]] && [ -d "$(pnpm -w root)/matrix-js-sdk/.git" ]
then
    DIST_VERSION=$("$DIR"/get-version-from-git.sh)
else
    DIST_VERSION=$(git describe --abbrev=0 --tags)
fi

DIST_VERSION=$("$DIR"/normalize-version.sh "$DIST_VERSION")

VERSION=$DIST_VERSION pnpm --dir apps/web build
