#!/usr/bin/env bash
# clean-local.sh — 本机开发垃圾清理（默认 dry-run，加 --apply 才真删）
#
# 规则
#   1) .worktrees/* ：分支已合入 origin/main（含 squash：合并后的树与 main 相同）、工作树干净、
#      且最后一次提交超过 2 小时 → 移除 worktree，并删掉本地已合并分支。
#      有未提交改动 / 未合并 / 2 小时内还有提交（可能正在做）→ 一点不动，只列出。
#   2) 未合并但已停工（最后一次提交超过 6 小时、且没有进程在里面）的 worktree：
#      只删构建残留（node_modules、.wrangler*、dist、coverage、.tmp、__pycache__），源码和提交保留。
#   3) 工作区缓存与临时：.npm-cache、.wrangler-logs、.tmp-x-test、*.log 之类；
#      /private/tmp 下 teamagent-* / inkboard-* / replay-*（超过 1 天）。
#   4) QQ 运行目录 ~/.inkboard-team：媒体临时文件、tts 缓存（超过 7 天）、__pycache__。
#
# 绝不删：.agent（证据文档）、令牌/配置/数据库、X-ASR 模型、未提交或未合并的代码、用户自己的文件。
#
# 用法：scripts/clean-local.sh            # 只报告，不删
#       scripts/clean-local.sh --apply    # 真删

set -uo pipefail

ROOT="${CLEAN_ROOT:-/Users/yanghongming/Projects}"
RUNTIME="${CLEAN_RUNTIME:-$HOME/.inkboard-team}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

ACTIVE_HOURS=6      # 6 小时内有提交，视为在做，不碰构建残留
REMOVE_MIN_HOURS=2  # 2 小时内有提交，哪怕已合并也先留着
TMP_DAYS=1

now=$(date +%s)
hr() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
kb2h() { awk -v k="$1" 'BEGIN{ if (k>=1048576) printf "%.2f GB", k/1048576; else if (k>=1024) printf "%.0f MB", k/1024; else printf "%d KB", k }'; }
du_kb() { du -sk "$@" 2>/dev/null | awk '{s+=$1} END{print s+0}'; }

# ---------- 找主仓库 ----------
# 工作区里可能同时存在几个独立 clone（每个 .git 都是目录）；挑注册 worktree 最多的那个，
# 它才是所有 .worktrees/* 共用的主仓库。
MAIN=""
BEST=0
for d in "$ROOT"/.worktrees/*/; do
  d="${d%/}"
  [ -d "$d/.git" ] || continue
  [ "$(git -C "$d" rev-parse --absolute-git-dir 2>/dev/null)" = "$d/.git" ] || continue
  n=$(git -C "$d" worktree list 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -gt "$BEST" ]; then BEST=$n; MAIN="$d"; fi
done
if [ -z "$MAIN" ]; then
  echo "找不到主仓库（$ROOT/.worktrees/*/.git 为目录的那个）" >&2; exit 1
fi

BASE=$(git -C "$MAIN" rev-parse origin/main 2>/dev/null || true)
if [ -z "$BASE" ]; then echo "读不到 origin/main" >&2; exit 1; fi
MAIN_TREE=$(git -C "$MAIN" rev-parse "$BASE^{tree}")

# 受保护的名字（永不删、不清残留）
PROTECT=" $(basename "$MAIN") TeamAgent-fr-ops "
[ -f "$ROOT/.agent/clean-protect.txt" ] && PROTECT="$PROTECT $(tr '\n' ' ' < "$ROOT/.agent/clean-protect.txt") "

RUNNING_CWDS=$(lsof -a -d cwd 2>/dev/null | awk '{print $NF}' | grep -F "$ROOT/.worktrees" | sort -u)

# ---------- 清理前后大小 ----------
scope_kb() {
  local s
  s=$(du_kb "$ROOT")
  s=$((s + $(du_kb /private/tmp/teamagent-* /private/tmp/inkboard-* /private/tmp/replay-* 2>/dev/null)))
  s=$((s + $(du_kb "$RUNTIME/media-tmp" "$RUNTIME/tts-cache" 2>/dev/null)))
  echo "$s"
}
BEFORE=$(scope_kb)

hr "清理计划（$([ $APPLY -eq 1 ] && echo 真删 || echo dry-run)）"
echo "主仓库 : $MAIN"
echo "基线   : origin/main $BASE"
echo "当前   : $(kb2h "$BEFORE")"

REMOVED_KB=0; STRIPPED_KB=0; EXTRA_KB=0
KEPT_DIRTY=(); KEPT_UNMERGED=(); KEPT_ACTIVE=(); KEPT_PROTECT=()

residue_dirs() { printf '%s\n' node_modules .wrangler .wrangler-logs .wrangler-home dist coverage .nyc_output .tmp __pycache__; }

worktree_residue_kb() {
  local p="$1" k=0 d
  for d in $(residue_dirs); do [ -e "$p/$d" ] && k=$((k + $(du_kb "$p/$d"))); done
  echo "$k"
}

strip_residue() { # $1=path  $2=label
  local p="$1" k d
  k=$(worktree_residue_kb "$p")
  [ "$k" -eq 0 ] && return 0
  echo "  [残留] $(kb2h "$k")  $(basename "$p")"
  if [ $APPLY -eq 1 ]; then
    for d in $(residue_dirs); do [ -e "$p/$d" ] && rm -rf "$p/$d" 2>/dev/null; done
  fi
  STRIPPED_KB=$((STRIPPED_KB + k))
}

hr "1) worktree"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  [ "$path" = "$MAIN" ] && continue
  name=$(basename "$path")
  br=$(git -C "$path" symbolic-ref --short -q HEAD 2>/dev/null || true)
  head=$(git -C "$path" rev-parse HEAD 2>/dev/null || true)
  [ -n "$head" ] || continue
  ct=$(git -C "$path" log -1 --format=%ct 2>/dev/null || echo 0)
  age_h=$(( (now - ct) / 3600 ))

  case "$PROTECT" in *" $name "*) KEPT_PROTECT+=("$name"); continue;; esac

  # 脏？忽略 .wrangler* 这类纯日志
  dirty=$(git -C "$path" status --porcelain --untracked-files=normal 2>/dev/null \
          | grep -vE '^\?\? \.worktrees/$' | grep -vE '^\?\? \.wrangler' | wc -l | tr -d ' ')

  merged=0
  if git -C "$MAIN" merge-base --is-ancestor "$head" "$BASE" 2>/dev/null; then
    merged=1
  else
    t=$(git -C "$MAIN" merge-tree --write-tree "$BASE" "$head" 2>/dev/null | head -1)
    [ "$t" = "$MAIN_TREE" ] && merged=1
  fi

  if [ "$dirty" != "0" ]; then KEPT_DIRTY+=("$name"); continue; fi

  if [ "$merged" = "1" ] && [ "$age_h" -ge "$REMOVE_MIN_HOURS" ]; then
    k=$(du_kb "$path")
    echo "  [移除] $(kb2h "$k")  $name  ${br:-<detached>}"
    if [ $APPLY -eq 1 ]; then
      # 删之前再确认一次：别人可能同时改过
      d2=$(git -C "$path" status --porcelain --untracked-files=normal 2>/dev/null \
           | grep -vE '^\?\? \.worktrees/$' | grep -vE '^\?\? \.wrangler' | wc -l | tr -d ' ')
      if [ "$d2" != "0" ]; then echo "    ! 状态已变（有改动），跳过"; continue; fi
      for d in $(residue_dirs); do [ -e "$path/$d" ] && rm -rf "$path/$d" 2>/dev/null; done
      if git -C "$MAIN" worktree remove "$path" 2>/dev/null; then
        case "$br" in
          ""|main|master) : ;;   # 本地 main/master 分支保留
          *) git -C "$MAIN" branch -D "$br" >/dev/null 2>&1 ;;
        esac
      else
        echo "    ! git worktree remove 失败，保留"
      fi
    fi
    REMOVED_KB=$((REMOVED_KB + k))
    continue
  fi

  if [ "$merged" = "0" ]; then
    if printf '%s\n' "$RUNNING_CWDS" | grep -qxF "$path" || [ "$age_h" -lt "$ACTIVE_HOURS" ]; then
      KEPT_ACTIVE+=("$name"); continue
    fi
    strip_residue "$path" residue
    KEPT_UNMERGED+=("$name")
  else
    KEPT_ACTIVE+=("$name")  # 已合并但太新，先留着
  fi
done < <(git -C "$MAIN" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')

hr "2) 工作区缓存与临时文件"
clean_path() { # $1=path $2=说明
  [ -e "$1" ] || return 0
  local k; k=$(du_kb "$1")
  [ "$k" -lt 64 ] && return 0
  echo "  [清理] $(kb2h "$k")  ${1#$ROOT/}"
  [ $APPLY -eq 1 ] && rm -rf "$1" 2>/dev/null
  EXTRA_KB=$((EXTRA_KB + k))
}
clean_path "$ROOT/.npm-cache"      "项目内 npm 缓存"
clean_path "$ROOT/.tmp-x-test"     "临时测试目录"
clean_path "$ROOT/.wrangler-logs"  "wrangler 日志"
clean_path "$ROOT/.wrangler"       "wrangler 临时"
clean_path "$ROOT/.f4-npm-test.log" "测试日志"

# /private/tmp：teamagent-* / inkboard-* / replay-*，超过 1 天
while IFS= read -r p; do
  [ -n "$p" ] || continue
  k=$(du_kb "$p")
  echo "  [清理] $(kb2h "$k")  ${p#/private/tmp/}"
  [ $APPLY -eq 1 ] && rm -rf "$p" 2>/dev/null
  EXTRA_KB=$((EXTRA_KB + k))
done < <(find /private/tmp -maxdepth 1 \( -name 'teamagent-*' -o -name 'inkboard-*' -o -name 'replay-*' \) -mtime +$TMP_DAYS 2>/dev/null)

hr "3) QQ 运行目录 $RUNTIME"
for sub in media-tmp tts-cache; do
  [ -d "$RUNTIME/$sub" ] || continue
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    k=$(du_kb "$p")
    echo "  [清理] $(kb2h "$k")  $sub/$(basename "$p")"
    [ $APPLY -eq 1 ] && rm -rf "$p" 2>/dev/null
    EXTRA_KB=$((EXTRA_KB + k))
  done < <(find "$RUNTIME/$sub" -mindepth 1 -maxdepth 1 -mtime +7 2>/dev/null)
done
while IFS= read -r p; do
  [ -n "$p" ] || continue
  k=$(du_kb "$p")
  echo "  [清理] $(kb2h "$k")  __pycache__"
  [ $APPLY -eq 1 ] && rm -rf "$p" 2>/dev/null
  EXTRA_KB=$((EXTRA_KB + k))
done < <(find "$RUNTIME" -maxdepth 2 -type d -name __pycache__ 2>/dev/null)

hr "4) 保留（不动）"
[ ${#KEPT_DIRTY[@]} -gt 0 ]    && echo "  有未提交改动: ${KEPT_DIRTY[*]}"
[ ${#KEPT_ACTIVE[@]} -gt 0 ]   && echo "  正在做/太新  : ${KEPT_ACTIVE[*]}"
[ ${#KEPT_UNMERGED[@]} -gt 0 ] && echo "  未合并已停工: ${#KEPT_UNMERGED[@]} 个（只清了构建残留，源码保留）"
[ ${#KEPT_PROTECT[@]} -gt 0 ]  && echo "  受保护      : ${KEPT_PROTECT[*]}"

AFTER=$(scope_kb)
FREED=$(( (REMOVED_KB + STRIPPED_KB + EXTRA_KB) ))
[ $APPLY -eq 1 ] && AFTER_REAL=$(scope_kb) || AFTER_REAL=$((BEFORE - FREED))

echo
echo "明细: worktree $(kb2h $REMOVED_KB) + 构建残留 $(kb2h $STRIPPED_KB) + 缓存临时 $(kb2h $EXTRA_KB)"
if [ $APPLY -eq 1 ]; then
  echo "清理前 $(kb2h "$BEFORE") → 清理后 $(kb2h "$AFTER")（预计释放 $(kb2h $FREED)）"
  mkdir -p "$ROOT/.agent" && echo "$(date '+%F %T') freed=$(kb2h $FREED) before=$(kb2h $BEFORE) after=$(kb2h $AFTER)" >> "$ROOT/.agent/clean-local.log"
else
  echo "清理前 $(kb2h "$BEFORE") → 清理后 $(kb2h "$AFTER_REAL")（预计释放 $(kb2h $FREED)；dry-run 未删任何东西）"
  echo "确认无误后运行: $0 --apply"
fi
