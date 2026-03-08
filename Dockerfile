# Estágio 1: Build do Go Bridge
FROM golang:1.24-alpine AS go-builder
WORKDIR /app/go-bridge
COPY go-bridge/ .
RUN go mod download && go build -o bridge .

# Estágio 2: Build do Node Server e Frontend
# Usamos a imagem "full" que já contém g++, make e python para evitar apt-get (OOM)
FROM node:20 AS node-builder
WORKDIR /app
COPY package*.json ./
# Limite de memória para o processo do NPM
ENV NODE_OPTIONS="--max-old-space-size=512"
RUN npm ci --no-audit --progress=false --loglevel=error
COPY . .
RUN npm run build && npm run build:server

# Estágio 3: Runtime leve (Slim)
FROM node:20-slim
WORKDIR /app

# Copiamos apenas o necessário do estágio de build do Node
COPY --from=node-builder /app/package*.json ./
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/dist ./dist
COPY --from=node-builder /app/dist_server ./dist_server

# Copiamos o bridge compilado do estágio Go
COPY --from=go-builder /app/go-bridge/bridge ./go-bridge/bridge

# Porta dinâmica do Railway
EXPOSE 3000

# Execução: Bridge em background e Node em foreground
CMD ./go-bridge/bridge & node dist_server/server.js
