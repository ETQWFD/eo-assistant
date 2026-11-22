FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_FILE=/data/eo.sqlite

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "src/server.js"]
