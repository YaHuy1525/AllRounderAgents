#!/bin/sh
# Entrypoint for the mastra-studio container (Dockerfile.mastra-studio).
#
# `mastra dev` guards its `.mastra` directory with a lockfile at
# /app/.mastra/dev.lock containing {"pid":...}. `docker restart` and the
# `unless-stopped` restart policy reuse the container's filesystem, so the
# lockfile survives, while each new instance lands on the same low PID (the
# CLI ends up at PID 20 in this image). The stale-lock check then sees its own
# PID alive, prints "Another development server instance is already running",
# and the dev server dies in a restart loop.
#
# Removing the leftover lock before startup is safe: an anonymous `docker run`
# of this image shows the file is never baked into layers, so anything present
# at start belongs to a dead previous instance of this same container.
rm -f /app/.mastra/dev.lock

exec npx --no-install mastra dev --dir src/mastra
