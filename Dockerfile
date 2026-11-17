FROM node:24-slim AS base
RUN npm install -g pnpm@11
WORKDIR /app

FROM base AS build
# Manifests first, so the install layer is cached until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @abacus/web build && pnpm prune --prod

# The whole workspace rather than Next's standalone output: the release
# command runs scripts/migrate.ts, which needs drizzle-orm, pg and the
# TypeScript sources it imports.
FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
