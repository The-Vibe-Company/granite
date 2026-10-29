FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV HUSKY=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    GRANITE_VAULT=/vault

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
COPY --from=build /app/templates ./templates
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /app/dist/index.js /usr/local/bin/docker-entrypoint.sh \
  && ln -s /app/dist/index.js /usr/local/bin/granite \
  && mkdir -p /vault

EXPOSE 3321
VOLUME ["/vault"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["granite", "mcp", "--transport", "http", "--host", "0.0.0.0"]
