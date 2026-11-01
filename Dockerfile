FROM node:10-alpine

# Create app directory
RUN mkdir -p /usr/src/app/logs
RUN mkdir -p /usr/src/app/config
RUN mkdir -p /usr/src/app/certs
WORKDIR /usr/src/app

# Install app dependencies
RUN apk add --no-cache tini python make gcc g++
COPY package*.json /usr/src/app/
RUN npm install

# Bundle app source
COPY . /usr/src/app

EXPOSE 443 1119
ENTRYPOINT ["/sbin/tini", "-v", "-e", "128", "--"]