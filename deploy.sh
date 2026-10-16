#!/bin/sh
set -eu

case "${1:-}" in
  -h|--help)
    printf '用法：%s\n构建当前源码并更新本地 Docker 服务，保留 .env 和 data。\n' "$0"
    exit 0
    ;;
  '') ;;
  *) printf '不支持的参数：%s；使用 --help 查看说明。\n' "$1" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  printf '此脚本不接受多个参数。\n' >&2
  exit 2
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$project_dir"

for dependency in docker curl; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf '缺少 %s，请先安装后重试。\n' "$dependency" >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  printf '需要 Docker Compose v2（docker compose）。\n' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf 'Docker 尚未就绪，请先启动 Docker Desktop 或 Docker 服务。\n' >&2
  exit 1
fi

# Serialize updates without requiring Linux-only flock on macOS.
lock_dir="$project_dir/.deploy-lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  printf '已有部署正在执行。若上次被强制终止，请确认无部署进程后移除 .deploy-lock。\n' >&2
  exit 1
fi
trap 'rmdir "$lock_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose() {
  docker compose --project-directory "$project_dir" --file "$project_dir/compose.yaml" "$@"
}

printf '[1/3] 检查 Compose 配置并构建镜像，旧服务继续运行…\n'
compose config --quiet
if ! compose build pagesentinel; then
  printf '镜像构建失败，未替换运行中的服务。\n' >&2
  exit 1
fi

printf '[2/3] 替换容器并加载当前 .env，继续使用项目 data 目录…\n'
if ! compose up -d --no-build --no-deps --force-recreate pagesentinel; then
  printf '容器更新失败。请运行 docker compose ps 和 docker compose logs --tail 50 pagesentinel 排查。\n' >&2
  exit 1
fi

printf '[3/3] 等待服务健康检查…\n'
health_url='http://127.0.0.1:3000/api/health'
attempt=0
while [ "$attempt" -lt 30 ]; do
  if health=$(curl --fail --silent --connect-timeout 1 --max-time 2 "$health_url" 2>/dev/null); then
    case "$health" in
      *'"status":"ok"'*)
        printf '部署完成：http://127.0.0.1:3000\n'
        exit 0
        ;;
    esac
  fi
  attempt=$((attempt + 1))
  sleep 1
done

printf '新服务未通过健康检查，请运行 docker compose logs --tail 50 pagesentinel 排查。\n' >&2
exit 1
