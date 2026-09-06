# Build from an extracted Linux release package, matching the target architecture.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 voidplayer && useradd --uid 1000 --gid 1000 --create-home voidplayer \
    && mkdir /data && chown voidplayer:voidplayer /data
WORKDIR /app
COPY --chmod=755 voidplayer ./voidplayer
COPY dist ./dist
COPY deploy/container.config.json ./voidplayer.config.example.json
COPY --chmod=755 deploy/container-entrypoint.sh ./start.sh
USER voidplayer
EXPOSE 5180
HEALTHCHECK --interval=20s --timeout=3s --start-period=30s --retries=3 CMD ["/app/voidplayer", "--data-dir", "/data", "--healthcheck"]
ENTRYPOINT ["/app/start.sh"]
