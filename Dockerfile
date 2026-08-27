# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
# Stamped into every log event so a failure traces back to the deploy that shipped
# it. The image carries no .git, so the sha has to be passed in at build time:
#   docker build --build-arg COMMIT_SHA=$(git rev-parse --short HEAD) .
ARG COMMIT_SHA=dev
ENV COMMIT_SHA=${COMMIT_SHA}
WORKDIR /app
USER node
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 4000
CMD ["node", "dist/server.js"]
