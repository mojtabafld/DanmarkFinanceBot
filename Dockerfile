# Stage 1: Build the application
FROM node:20-alpine AS builder

WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

# Copy dependency files
COPY package.json tsconfig.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm install

# Copy source code and build
COPY src ./src/
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache openssl libc6-compat tesseract-ocr tesseract-ocr-data-dan tesseract-ocr-data-eng

# Copy package files and install only production dependencies
COPY package.json ./
RUN npm install --only=production

# Copy compiled code and Prisma files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# Prisma requires generated files to be copied explicitly
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Expose port (not strictly needed for polling, but useful if webhook is configured later)
EXPOSE 3000

# Run migrations and start the application
CMD ["sh", "-c", "npx prisma db push && npm start"]
