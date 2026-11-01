FROM node:26.13.0-trixie-slim AS dependencies
WORKDIR /usr/src/app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26.13.0-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p logs config certs
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY . .
EXPOSE 443 1119
ENTRYPOINT ["/usr/bin/tini", "-v", "-e", "128", "--"]
