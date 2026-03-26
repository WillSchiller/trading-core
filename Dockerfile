FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY config/ ./config/
COPY sql/ ./sql/
COPY scripts/ ./scripts/
COPY models/ ./models/

RUN npm install -g tsx

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
