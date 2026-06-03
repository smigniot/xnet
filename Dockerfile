# Xnet - single image: Gun relay + static SPA.
FROM node:20-alpine

WORKDIR /app

# Install only production deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

# App source.
COPY server ./server
COPY public ./public

# Encrypted graph persistence lives here; mount a volume to keep it.
ENV GUN_DATA=/app/data
RUN mkdir -p /app/data

ENV PORT=8765
EXPOSE 8765

CMD ["node", "server/server.js"]
