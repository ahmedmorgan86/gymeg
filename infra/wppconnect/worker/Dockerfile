FROM node:22.22.2-alpine
WORKDIR /app
COPY package.json ./
COPY index.mjs ./
EXPOSE 3100
USER node
CMD ["node", "index.mjs"]
