# Estágio 1: Build do Go Bridge
FROM golang:1.24-alpine AS go-builder
WORKDIR /app/go-bridge
COPY go-bridge/ .
RUN go mod download && go build -o bridge .

# Estágio 2: Build do Node Server
FROM node:20-slim
WORKDIR /app

# Instalar dependências para compilar nativos no Debian Slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Definir limite de memória conservador e desativar concorrência do NPM
ENV NODE_OPTIONS="--max-old-space-size=384"
RUN npm config set maxsockets 1
RUN npm install --no-audit --progress=false --loglevel=error

COPY . .
# Copiar o bridge compilado
COPY --from=go-builder /app/go-bridge/bridge ./go-bridge/bridge

# Build do frontend e do servidor
RUN npm run build && npm run build:server

# Porta dinâmica do Railway
EXPOSE 3000

# Rodar a bridge em background e o servidor em foreground
CMD ./go-bridge/bridge & npm start
