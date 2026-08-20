# Optional containerized deployment path. The current production deployment
# (see README → Deployment) runs this app directly under systemd on a
# DigitalOcean droplet — that stays authoritative. This image exists so the
# app can be run identically in CI, locally, or on a container platform
# without hand-reproducing the systemd setup.

FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY docs ./docs

EXPOSE 4000
USER node
CMD ["node", "src/server.js"]
