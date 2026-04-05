FROM debian:bookworm-slim AS engine-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential clang lld git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG EDITION=YANEURAOU_ENGINE_MATERIAL
ARG TARGET_CPU=OTHER

RUN git clone --depth 1 https://github.com/yaneurao/YaneuraOu.git /yaneuraou
WORKDIR /yaneuraou/source
RUN make clean YANEURAOU_EDITION=${EDITION} && \
    make -j$(nproc) tournament COMPILER=clang++ YANEURAOU_EDITION=${EDITION} TARGET_CPU=${TARGET_CPU}

FROM node:22-slim
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/worker/package.json ./packages/worker/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY packages/server/ ./packages/server/
COPY packages/worker/ ./packages/worker/
COPY --from=engine-builder /yaneuraou/source/YaneuraOu-by-gcc /usr/local/bin/yaneuraou
