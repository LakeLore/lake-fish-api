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

# Survival modules are required at runtime via relative paths (../state/survival)
COPY mn-lake-fish/survival.js ./mn-lake-fish/survival.js
COPY sd-lake-fish/survival.js ./sd-lake-fish/survival.js
COPY nd-lake-fish/survival.js ./nd-lake-fish/survival.js
COPY ia-lake-fish/survival.js ./ia-lake-fish/survival.js
COPY ne-lake-fish/survival.js ./ne-lake-fish/survival.js
COPY wi-lake-fish/survival.js ./wi-lake-fish/survival.js
COPY mi-lake-fish/survival.js ./mi-lake-fish/survival.js

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
