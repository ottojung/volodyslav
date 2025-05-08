FROM node:23.11 AS builder
WORKDIR /workspace
COPY package* frontend/package* backend/package* ./
RUN npm install
RUN npm test
RUN npm run static-analysis
# copy everything
COPY . .
RUN npm ci
