# Estágio 1: Build do Go Bridge
FROM golang:1.24-alpine AS go-builder
# Instalar git para baixar dependências que o exigem
RUN apk add --no-cache git
WORKDIR /app/go-bridge
COPY go-bridge/ .
RUN go mod download && go build -o bridge .

# Estágio 2: Build do Node Server e Frontend
FROM node:20-alpine AS node-builder
WORKDIR /app

# Instalar ferramentas de build (apk é mais leve que apt-get)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
# Limite de memória rigoroso para o processo do NPM/Node
ENV NODE_OPTIONS="--max-old-space-size=350"
RUN npm install --no-audit --progress=false --loglevel=error --no-fund

COPY . .
# Rodar build com limite de memória
RUN npm run build && npm run build:server

# Estágio 3: Runtime leve (Alpine)
FROM node:20-alpine
WORKDIR /app

# Copiamos apenas os artefatos necessários
COPY --from=node-builder /app/package*.json ./
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/dist ./dist
COPY --from=node-builder /app/dist_server ./dist_server
COPY --from=go-builder /app/go-bridge/bridge ./go-bridge/bridge

# Porta dinâmica
EXPOSE 3000

# Execução otimizada
CMD ./go-bridge/bridge & node dist_server/server.js
