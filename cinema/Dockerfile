FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV CINEMA_HOST=0.0.0.0
EXPOSE 3010
CMD ["node", "cinema/server.js"]
