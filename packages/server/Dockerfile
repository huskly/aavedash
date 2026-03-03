FROM node:25-alpine AS builder

WORKDIR /app
COPY ../../package.json ../../yarn.lock ./
COPY packages/aave-core/package.json packages/aave-core/
COPY packages/server/package.json packages/server/

RUN yarn install --frozen-lockfile

COPY packages/aave-core/ packages/aave-core/
COPY packages/server/ packages/server/

RUN yarn workspace @aave-monitor/core run build
RUN yarn workspace @aave-monitor/server run build

FROM node:22-alpine

WORKDIR /app
COPY --from=builder /app/package.json /app/yarn.lock ./
COPY --from=builder /app/packages/aave-core/package.json packages/aave-core/
COPY --from=builder /app/packages/aave-core/dist/ packages/aave-core/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/node_modules/ node_modules/

WORKDIR /app/packages/server
RUN mkdir -p data

EXPOSE 3001
CMD ["node", "dist/index.js"]
