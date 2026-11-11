FROM oven/bun:1.4.4-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json bunfig.toml ./
COPY src ./src
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD bun -e "fetch('http://localhost:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/main.ts"]
