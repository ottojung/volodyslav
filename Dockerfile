FROM node:24 AS builder
WORKDIR /app
# copy everything
COPY . .
# install all deps (dev + prod) to build both workspaces
RUN npm install
# run my monorepo build (frontend + types)
RUN npm run build
