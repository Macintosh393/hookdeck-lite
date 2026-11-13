# Image of the mock receiver, used by docker-compose (and on Day 4 as the public demo destination).
# Build context is the repository root:  docker compose build mock-receiver
#
# Two stages: "build" has pnpm, TypeScript and the sources; "run" has only the compiled JavaScript.
# The receiver uses node:http and nothing else, so the final image needs no node_modules at all.

FROM node:24-alpine AS build
WORKDIR /repo
# corepack reads "packageManager" in package.json and provides exactly that pnpm version.
RUN corepack enable
COPY . .
# Install only what this one workspace needs to compile (TypeScript and its types).
RUN pnpm install --frozen-lockfile --filter @hdl/mock-receiver
RUN pnpm --filter @hdl/mock-receiver build

FROM node:24-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
# package.json carries "type": "module", which tells Node the compiled files are ES modules.
COPY --from=build /repo/tools/mock-receiver/package.json ./package.json
COPY --from=build /repo/tools/mock-receiver/dist ./dist
# The node image ships an unprivileged user called "node". Do not run as root.
USER node
EXPOSE 4000
# Exec form (a JSON array): Node is PID 1's direct child and receives SIGTERM itself.
# The shell form would wrap it in `sh -c`, which does not forward signals.
CMD ["node", "dist/main.js"]
