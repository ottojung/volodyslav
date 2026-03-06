FROM node:25.8
WORKDIR /workspace
RUN apt-get update -y
RUN apt-get install -y rsync git
COPY scripts/development/termux-notification /usr/local/bin/termux-notification
COPY scripts/development/termux-wifi-connectioninfo /usr/local/bin/termux-wifi-connectioninfo
COPY scripts/development/volodyslav-daily-tasks /usr/local/bin/volodyslav-daily-tasks
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
RUN npm ci
COPY . .
ARG VOLODYSLAV_BASEURL=''
RUN sh scripts/install /usr/local
ENTRYPOINT [ "volodyslav" ]
