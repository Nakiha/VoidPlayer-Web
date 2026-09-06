FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY dist ./dist
COPY deploy/container.config.json ./voidplayer.config.json
USER node
EXPOSE 5180
HEALTHCHECK --interval=20s --timeout=3s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:5180/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.ts", "--config", "voidplayer.config.json"]
