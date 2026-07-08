# Build stage — compiles better-sqlite3 (native C++ module)
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /srv/lake-fish-mobile-server
COPY lake-fish-mobile-server/package.json lake-fish-mobile-server/package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage — lean image without build tools
FROM node:20-alpine
WORKDIR /srv

COPY --from=builder /srv/lake-fish-mobile-server/node_modules ./lake-fish-mobile-server/node_modules
COPY lake-fish-mobile-server/server.js                         ./lake-fish-mobile-server/server.js
COPY lake-fish-mobile-server/entitlement.js                    ./lake-fish-mobile-server/entitlement.js
COPY lake-fish-mobile-server/server/canonical.js               ./lake-fish-mobile-server/server/canonical.js

# Canonical data layer: registry + schema assertion + shared survival model.
# server.js requires it via ../lakelore-data and exits at startup if missing;
# every active state serves from the generic handlers against /data/{state}.db
# built by lakelore-data's normalize.js. (The per-state survival.js modules are
# gone — the shared lakelore-data survival model covers all states.)
COPY lakelore-data/index.js               ./lakelore-data/index.js
COPY lakelore-data/registry/states.json   ./lakelore-data/registry/states.json
COPY lakelore-data/registry/species.json  ./lakelore-data/registry/species.json
COPY lakelore-data/schema/canonical.sql   ./lakelore-data/schema/canonical.sql
COPY lakelore-data/schema/assert-schema.js ./lakelore-data/schema/assert-schema.js
COPY lakelore-data/survival/index.js      ./lakelore-data/survival/index.js
COPY lakelore-data/survival/chains.json   ./lakelore-data/survival/chains.json

WORKDIR /srv/lake-fish-mobile-server

# Databases and PDFs live on a persistent volume at /data, not in the image.
# This lets you upload fresh databases without a full redeploy.
ENV MN_DB_PATH=/data/mn.db \
    SD_DB_PATH=/data/sd.db \
    ND_DB_PATH=/data/nd.db \
    IA_DB_PATH=/data/ia.db \
    NE_DB_PATH=/data/ne.db \
    WI_DB_PATH=/data/wi.db \
    NE_PDF_DIR=/data/pdfs \
    MI_DB_PATH=/data/mi.db \
    NODE_ENV=production

EXPOSE 3100
CMD ["node", "server.js"]
