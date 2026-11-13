# Image of the mock receiver, used by docker-compose (and on Day 4 as the public demo destination).
# Build context is the repository root:  docker compose build mock-receiver
#
# Two stages: "build" has pnpm, TypeScript and the sources; "run" has only the compiled JavaScript
# and the one runtime dependency (standardwebhooks, which checks signatures for `verifySecret`).

FROM node:24-alpine AS build
WORKDIR /repo
# corepack reads "packageManager" in package.json and provides exactly that pnpm version.
RUN corepack enable
COPY . .
# Install only what this one workspace needs.
RUN pnpm install --frozen-lockfile --filter @hdl/mock-receiver
RUN pnpm --filter @hdl/mock-receiver build
# `pnpm deploy` copies the package and its production dependencies to /out as real files.
# (node_modules inside the workspace are symlinks into a shared store and cannot be copied as they are.)
RUN pnpm --filter @hdl/mock-receiver deploy --prod /out

FROM node:24-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
# package.json carries "type": "module", which tells Node the compiled files are ES modules.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# The node image ships an unprivileged user called "node". Do not run as root.
USER node
EXPOSE 4000
# Exec form (a JSON array): Node is PID 1's direct child and receives SIGTERM itself.
# The shell form would wrap it in `sh -c`, which does not forward signals.
CMD ["node", "dist/main.js"]
