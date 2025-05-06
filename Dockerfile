FROM node:24 AS builder
WORKDIR /app
COPY package* frontend/package* backend/package* .
RUN npm install
# copy everything
COPY . .
RUN npm ci
# install all deps (dev + prod) to build both workspaces
RUN npm run build
