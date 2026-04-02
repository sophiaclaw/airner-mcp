FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all deps (including dev for build)
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
