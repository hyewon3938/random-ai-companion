FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

CMD ["yarn", "start"]
