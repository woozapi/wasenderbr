# Estágio 1: Build do Go Bridge
FROM golang:1.24-alpine AS go-builder
WORKDIR /app/go-bridge
COPY go-bridge/ .
RUN go mod download && go build -o bridge .

# Estágio 2: Build do Node Server
FROM node:20-alpine
WORKDIR /app

# Instalar dependências para compilar better-sqlite3 (se necessário)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
# Definir limite de memória para o Node e usar npm ci para um build mais leve
ENV NODE_OPTIONS="--max-old-space-size=448"
RUN npm ci --no-audit --progress=false --loglevel=error

COPY . .
# Copiar o bridge compilado
COPY --from=go-builder /app/go-bridge/bridge ./go-bridge/bridge

# Build do frontend e do servidor
RUN npm run build && npm run build:server

# Porta dinâmica do Railway
EXPOSE 3000

# Rodar a bridge em background e o servidor em foreground
CMD ./go-bridge/bridge & npm start
