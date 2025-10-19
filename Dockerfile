FROM node:23.11
WORKDIR /workspace
COPY package* frontend/package* backend/package* ./
RUN npm install
# copy everything
COPY . .
RUN npm ci
