FROM node:22-alpine

# dumb-init makes PID 1 forward SIGTERM properly, so the graceful shutdown in
# server.js actually runs. Without it Docker SIGKILLs the container after the
# grace period and in-flight requests are dropped.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The metadata cache is written at runtime, so the directory must exist and be
# owned by the unprivileged user.
RUN mkdir -p data && chown -R node:node /app

USER node

# Inside a container, loopback isn't reachable from the host.
ENV HOST=0.0.0.0
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
