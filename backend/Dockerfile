FROM node:20-alpine

WORKDIR /app

# Dependências
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Código
COPY . .

# Diretórios de dados
RUN mkdir -p uploads logs

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
