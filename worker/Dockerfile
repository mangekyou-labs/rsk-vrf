# Worker image. Node 24 runs the TypeScript sources directly; nothing is compiled.
# Build from the worker directory: docker build -t rsk-vrf-worker worker
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

# The worker writes nothing to disk; run it as the image's unprivileged user.
USER node
ENTRYPOINT ["node"]
CMD ["src/run.ts"]
