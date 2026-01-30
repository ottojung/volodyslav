FROM node:23.11
WORKDIR /workspace
COPY package* frontend/package* backend/package* ./
RUN npm install
COPY . .
RUN sh scripts/install /usr/local
ENTRYPOINT [ "volodyslav" ]
