FROM node:25.3
WORKDIR /workspace
RUN apt-get update -y
RUN apt-get install -y rsync git
COPY package* frontend/package* backend/package* ./
RUN npm install
COPY . .
COPY scripts/development/termux-notification /usr/local/bin/termux-notification
COPY scripts/development/termux-wifi-connectioninfo /usr/local/bin/termux-wifi-connectioninfo
RUN sh scripts/install /usr/local
ENTRYPOINT [ "volodyslav" ]
