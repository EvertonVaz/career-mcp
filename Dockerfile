# syntax=docker/dockerfile:1

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:25-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# ── Dependências de produção ─────────────────────────────────────────────────
# Estágio separado para o runtime não herdar as devDependencies.
FROM node:25-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:25-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Pontos de montagem dos volumes do Coolify. Criados aqui para existirem com o
# dono certo mesmo antes do primeiro mount.
RUN mkdir -p /app/data /app/history /app/output && chown -R node:node /app

USER node

EXPOSE 3000

# O Coolify também aponta para /health; este aqui é o do próprio Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${MCP_PORT:-3000}/health" || exit 1

CMD ["node", "dist/server.js"]
