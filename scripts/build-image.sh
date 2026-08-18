#!/usr/bin/env bash
# 构建镜像并**打全所有必要的 tag**。
#
# 为什么要有这个脚本：飞雁一旦配了 FEIYAN_MCP_REGISTRY_MIRROR，它 inspect 的是
# **带镜像源前缀**的 ref（`<mirror>/moraya/toutiao-mcp:latest`），而不是裸名。
# 只打裸名 tag 的话，`docker build` 成功、容器也起得来，**跑的却是上一版镜像** ——
# 现象是"改的代码没生效"，而日志一切正常（2026-08-18 实测踩过：容器跑着 11 小时前
# 的镜像，返回 imageStrategy=paste-url，白排查一轮）。
#
#   bash scripts/build-image.sh                     # 只打裸名
#   FEIYAN_MCP_REGISTRY_MIRROR=<host> bash scripts/build-image.sh
#   NODE_IMAGE=docker.m.daocloud.io/library/node:22-slim bash scripts/build-image.sh
set -euo pipefail

IMAGE="${IMAGE:-moraya/toutiao-mcp}"
TAG="${TAG:-latest}"
NODE_IMAGE="${NODE_IMAGE:-node:22-slim}"
MIRROR="${FEIYAN_MCP_REGISTRY_MIRROR:-}"

TAGS=(-t "$IMAGE:$TAG")
[ -n "$MIRROR" ] && TAGS+=(-t "${MIRROR%/}/$IMAGE:$TAG")

echo "==> 构建 $IMAGE:$TAG（基础镜像 $NODE_IMAGE）"
docker build --build-arg "NODE_IMAGE=$NODE_IMAGE" "${TAGS[@]}" "$(dirname "$0")/.."

echo "==> 已打 tag："
for i in "${!TAGS[@]}"; do [ "${TAGS[$i]}" = "-t" ] && echo "    ${TAGS[$((i+1))]}"; done

# 自检：所有 tag 必须指向同一个 image id，否则等于没更新
IDS=$(for i in "${!TAGS[@]}"; do
  [ "${TAGS[$i]}" = "-t" ] && docker image inspect "${TAGS[$((i+1))]}" --format '{{.Id}}'
done | sort -u | wc -l)
[ "$IDS" -eq 1 ] || { echo "xx tag 指向了不同的 image id —— 容器可能跑到旧镜像" >&2; exit 1; }
echo "==> 自检通过：所有 tag 指向同一镜像"
