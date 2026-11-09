#!/usr/bin/env bash
# 把「最近修改」插件安装到指定 Obsidian 库
# 用法: ./install.sh /path/to/your/vault

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="${1:-}"

if [[ -z "$VAULT" ]]; then
  echo "用法: ./install.sh /path/to/your/vault" >&2
  echo "示例: ./install.sh ~/Documents/MyVault" >&2
  exit 1
fi

# 支持传入库名（默认在 ~/Documents 下查找）
if [[ ! -d "$VAULT" && -d "$HOME/Documents/$VAULT" ]]; then
  VAULT="$HOME/Documents/$VAULT"
fi

if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "错误: $VAULT 看起来不是 Obsidian 库（没有 .obsidian 目录）" >&2
  exit 1
fi

DEST="$VAULT/.obsidian/plugins/recent-notes"
mkdir -p "$DEST"
cp "$SRC_DIR/manifest.json" "$SRC_DIR/main.js" "$SRC_DIR/styles.css" "$DEST/"

# 加入「已启用插件」列表，省去手动开启这一步
LIST="$VAULT/.obsidian/community-plugins.json"
python3 - "$LIST" <<'PY'
import json, os, sys

path = sys.argv[1]
data = []
if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, list):
            data = loaded
    except Exception:
        data = []

if "recent-notes" not in data:
    data.append("recent-notes")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print("已加入启用列表")
else:
    print("启用列表已包含，跳过")
PY

echo "已安装到: $DEST"
echo
echo "最后一步：完全退出并重新打开 Obsidian，然后在 设置 → 第三方插件 关闭「受限模式」"
