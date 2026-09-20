FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist

RUN groupadd --system app && useradd --system --gid app app \
  && mkdir -p /app/data \
  && chown -R app:app /app
USER app

CMD ["node", "dist/src/index.js"]
