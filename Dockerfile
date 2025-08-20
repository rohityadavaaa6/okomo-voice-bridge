FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Cloud Run listens on $PORT. We'll bind to 8080 in server.js (Cloud Run maps it).
EXPOSE 8080
ENV NODE_ENV=production

CMD ["node","server.js"]
