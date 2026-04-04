FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential clang lld git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG EDITION=YANEURAOU_ENGINE_MATERIAL
ARG TARGET_CPU=AVX2

RUN git clone --depth 1 https://github.com/yaneurao/YaneuraOu.git /yaneuraou
WORKDIR /yaneuraou/source
RUN make clean YANEURAOU_EDITION=${EDITION} && \
    make -j$(nproc) tournament COMPILER=clang++ YANEURAOU_EDITION=${EDITION} TARGET_CPU=${TARGET_CPU}

FROM ubuntu:24.04
COPY --from=builder /yaneuraou/source/YaneuraOu-by-gcc /usr/local/bin/yaneuraou
ENTRYPOINT ["yaneuraou"]
