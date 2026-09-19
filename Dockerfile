# syntax=docker/dockerfile:1
FROM node:24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run check && npm run build

FROM node:24 AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
RUN mkdir -p /data/state /data/reports && chown -R node:node /data && chmod 700 /data /data/state /data/reports
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["web", "--host", "0.0.0.0", "--port", "8787", "--state-dir", "/data/state", "--report-dir", "/data/reports"]
