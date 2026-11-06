# Mavi ERP — one-image deployment (works on Render, Railway, Fly, any VPS)
FROM node:20-slim

WORKDIR /app

# build tools only if better-sqlite3 needs to compile; slim image has prebuilds usually
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Let Node size its heap from the container memory limit; a fixed 64 MB heap
# can exhaust during image uploads and normal application activity.
ENV PORT=3000
ENV DB_PATH=/data/mavi.db

# data must live on a mounted volume so orders survive redeploys
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "src/bootstrap.js"]
