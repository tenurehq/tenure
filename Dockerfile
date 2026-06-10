FROM dhi.io/node:26-alpine-dev AS crypt
RUN apk add --no-cache curl ca-certificates

ARG MONGO_CRYPT_VERSION=8.3.2
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      URL="https://downloads.mongodb.com/linux/mongo_crypt_shared_v1-linux-aarch64-enterprise-ubuntu2204-${MONGO_CRYPT_VERSION}.tgz"; \
    else \
      URL="https://downloads.mongodb.com/linux/mongo_crypt_shared_v1-linux-x86_64-enterprise-debian12-${MONGO_CRYPT_VERSION}.tgz"; \
    fi && \
    mkdir -p /tmp/crypt /tmp/lib && \
    curl -fsSL --max-time 120 "$URL" | tar -xz -C /tmp/crypt --strip-components=1 && \
    find /tmp/crypt -name "mongo_crypt_v1.so" -exec cp {} /tmp/lib/mongo_crypt_v1.so \;

FROM dhi.io/node:26-debian13-dev AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dhi.io/node:26-alpine-dev AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM dhi.io/node:26-alpine-dev AS setup
RUN addgroup -S tenure && adduser -S -G tenure -H -s /sbin/nologin tenure

FROM dhi.io/node:26-debian13-dev AS runtime
WORKDIR /app

COPY --from=setup /etc/passwd /etc/passwd
COPY --from=setup /etc/group /etc/group

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/static ./dist/static
COPY --from=crypt /tmp/lib/mongo_crypt_v1.so /app/vendor/mongo_crypt_v1.so

COPY docker-compose.yml /app/docker-compose.yml

RUN mkdir -p /app/config /app/.tenure && \
    chown -R tenure:tenure /app/config /app/.tenure

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

USER tenure

EXPOSE 5757

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]