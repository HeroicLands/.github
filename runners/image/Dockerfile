# syntax=docker/dockerfile:1
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Job image for container-mode runners (Intrepid, atlas). It carries the tool
# set excelsior's host provides, for linux/amd64 and linux/arm64.

# Digest of the multi-arch index for act-24.04.
FROM catthehacker/ubuntu:act-24.04@sha256:c58e2b364da03b0c804c7d660f2ecbedf2f221a382b9baa0b344b0144780ff43

ARG TARGETARCH

ARG NODE_VERSION=24.11.1
ARG NODE_SHA256_AMD64=60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8
ARG NODE_SHA256_ARM64=6b0863fb9f627bf4a6c5948dce1de4398174a2e05dbe717503d828e211ca01f0

ARG TYPST_VERSION=0.15.1
ARG TYPST_SHA256_AMD64=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
ARG TYPST_SHA256_ARM64=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee

ARG HUGO_VERSION=0.167.0
ARG HUGO_SHA256_AMD64=0163f5c3deddac1f494a1629ddc40c65d18de9d5794facd98f7f96ac2c7d8957
ARG HUGO_SHA256_ARM64=c73eaba13738754b50de4d07606670d5c0cd2eaaf2057af657cec9efd3b01876

ARG YQ_VERSION=4.47.2
ARG YQ_SHA256_AMD64=1bb99e1019e23de33c7e6afc23e93dad72aad6cf2cb03c797f068ea79814ddb0
ARG YQ_SHA256_ARM64=05df1f6aed334f223bb3e6a967db259f7185e33650c3b6447625e16fea0ed31f

USER root
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      graphviz jq poppler-utils unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in \
      amd64) node_arch=x64;    node_sha="${NODE_SHA256_AMD64}";  typst_arch=x86_64;  typst_sha="${TYPST_SHA256_AMD64}"; \
             hugo_arch=amd64;  hugo_sha="${HUGO_SHA256_AMD64}";  yq_sha="${YQ_SHA256_AMD64}" ;; \
      arm64) node_arch=arm64;  node_sha="${NODE_SHA256_ARM64}";  typst_arch=aarch64; typst_sha="${TYPST_SHA256_ARM64}"; \
             hugo_arch=arm64;  hugo_sha="${HUGO_SHA256_ARM64}";  yq_sha="${YQ_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    dl() { curl --fail --silent --show-error --location --retry 5 --retry-delay 5 --retry-all-errors -o "$1" "$2"; echo "$3  $1" | sha256sum --check --status; }; \
    work="$(mktemp -d)"; cd "${work}"; \
    dl node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" "${node_sha}"; \
    tar -xJf node.tar.xz --strip-components=1 -C /usr/local --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'; \
    dl typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${typst_arch}-unknown-linux-musl.tar.xz" "${typst_sha}"; \
    tar -xJf typst.tar.xz --strip-components=1 -C /usr/local/bin "typst-${typst_arch}-unknown-linux-musl/typst"; \
    dl hugo.tar.gz "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${hugo_arch}.tar.gz" "${hugo_sha}"; \
    tar -xzf hugo.tar.gz -C /usr/local/bin hugo; \
    dl yq "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${arch}" "${yq_sha}"; \
    install -m 0755 yq /usr/local/bin/yq; \
    cd /; rm -rf "${work}"

# The base image puts its own Node on PATH ahead of /usr/local/bin.
ENV PATH=/usr/local/bin:${PATH}

RUN node --version && typst --version && hugo version && dot -V && pdftotext -v && jq --version && yq --version
