FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY data ./data
COPY public ./public
# keep the SQLite database on a mounted volume so it survives redeploys
ENV DB_FILE=/data/lekker.db BACKUP_DIR=/data/backups
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
