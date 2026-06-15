#!/bin/sh
set -e

is_mount() {
  point="$1"
  if [ ! -e "$point" ]; then
    return 1
  fi
  resolved=$(readlink -f "$point" 2>/dev/null || printf '%s' "$point")
  grep -qs " ${resolved} " /proc/mounts 2>/dev/null
}

resolve_data_dir() {
  if [ -n "${AURRAL_DATA_DIR:-}" ]; then
    readlink -f "$AURRAL_DATA_DIR" 2>/dev/null || printf '%s' "$AURRAL_DATA_DIR"
    return
  fi

  canonical=/config
  legacy=/app/backend/data

  mkdir -p "$canonical" "$legacy"

  if [ -f "$canonical/aurral.db" ]; then
    printf '%s' "$canonical"
    return
  fi
  if [ -f "$legacy/aurral.db" ]; then
    printf '%s' "$legacy"
    return
  fi

  if is_mount "$canonical"; then
    printf '%s' "$canonical"
    return
  fi
  if is_mount "$legacy"; then
    printf '%s' "$legacy"
    return
  fi

  printf '%s' "$canonical"
}

link_compat_paths() {
  primary="$1"
  canonical=/config
  legacy=/app/backend/data

  if [ "$primary" = "$canonical" ]; then
    if is_mount "$legacy" || [ -L "$legacy" ]; then
      return
    fi
    rm -rf "$legacy"
    ln -sfn "$canonical" "$legacy"
    return
  fi

  if [ "$primary" = "$legacy" ]; then
    if is_mount "$canonical" || [ -L "$canonical" ]; then
      return
    fi
    rm -rf "$canonical"
    ln -sfn "$legacy" "$canonical"
  fi
}

if [ "$(id -u)" = "0" ]; then
    target_uid="${AURRAL_UID:-${PUID:-}}"
    target_gid="${AURRAL_GID:-${PGID:-}}"

    default_uid="$(awk -F: '$1=="nodejs"{print $3; exit}' /etc/passwd)"
    default_gid="$(awk -F: '$1=="nodejs"{print $4; exit}' /etc/group)"

    if [ -z "$default_uid" ]; then
        default_uid="1001"
    fi
    if [ -z "$default_gid" ]; then
        default_gid="1001"
    fi

    if [ -z "$target_uid" ]; then
        target_uid="$default_uid"
    fi
    if [ -z "$target_gid" ]; then
        target_gid="$default_gid"
    fi

    target_group="$(awk -F: -v gid="$target_gid" '$3==gid{print $1; exit}' /etc/group)"
    if [ -z "$target_group" ]; then
        groupadd -g "$target_gid" aurral
        target_group="aurral"
    fi

    target_user="$(awk -F: -v uid="$target_uid" '$3==uid{print $1; exit}' /etc/passwd)"
    if [ -z "$target_user" ]; then
        useradd -u "$target_uid" -g "$target_group" -M -s /usr/sbin/nologin aurral
        target_user="aurral"
    fi

    AURRAL_DATA_DIR="$(resolve_data_dir)"
    export AURRAL_DATA_DIR
    link_compat_paths "$AURRAL_DATA_DIR"
    mkdir -p "$AURRAL_DATA_DIR"
    chown -R "$target_uid:$target_gid" /config /app/backend/data "$AURRAL_DATA_DIR"

    exec gosu "$target_uid:$target_gid" env AURRAL_DATA_DIR="$AURRAL_DATA_DIR" "$@"
fi

if [ -z "${AURRAL_DATA_DIR:-}" ]; then
  AURRAL_DATA_DIR="$(resolve_data_dir)"
  export AURRAL_DATA_DIR
fi

exec "$@"
