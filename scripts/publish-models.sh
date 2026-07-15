#!/bin/bash
# 把 renderer/models（+ models.json）打成 tar.gz 传到 OSS。
# 从有模型的机器上手动跑（CI 干净 checkout 没有模型，也不该有）。
# 需要环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET。
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d renderer/models ] || { echo "renderer/models 不存在——本机没有模型，没法打包"; exit 1; }
: "${OSS_ACCESS_KEY_ID:?需要 OSS_ACCESS_KEY_ID}"
: "${OSS_ACCESS_KEY_SECRET:?需要 OSS_ACCESS_KEY_SECRET}"

OUT=cicy-pet-models.tar.gz
echo "打包 renderer/{models.json,models} → $OUT"
tar -czf "$OUT" -C renderer models.json models
echo "  大小: $(du -h "$OUT" | cut -f1)"

# ossutil（mac）
OSSUTIL=./ossutil
[ -x "$OSSUTIL" ] || { curl -sL https://gosspublic.alicdn.com/ossutil/1.7.18/ossutilmac64 -o "$OSSUTIL"; chmod +x "$OSSUTIL"; }
"$OSSUTIL" config -e oss-cn-shanghai.aliyuncs.com -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" >/dev/null
"$OSSUTIL" cp "$OUT" oss://cicy-1372193042-cn/releases/cicy-pet-models.tar.gz -f --acl public-read
echo "已上传: https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com/releases/cicy-pet-models.tar.gz"
rm -f "$OUT"
