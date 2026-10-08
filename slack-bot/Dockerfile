FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# Slack -> GitHub username links live here; mount a volume so they survive restarts.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "src/app.js"]
