FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 TRUST_PROXY=1
COPY package*.json ./
COPY scripts ./scripts
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
