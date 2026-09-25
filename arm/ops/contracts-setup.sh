#!/usr/bin/env bash
# One-time: install forge deps on the server via GitHub tarballs (git smart-HTTP is blocked there).
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd /opt/arm/contracts
mkdir -p lib
fetch() { # name repo tag
  if [ ! -d "lib/$1" ]; then
    curl -sL "https://github.com/$2/archive/refs/tags/$3.tar.gz" -o "/tmp/$1.tgz"
    mkdir -p "lib/$1" && tar -xzf "/tmp/$1.tgz" -C "lib/$1" --strip-components=1 && rm "/tmp/$1.tgz"
    echo "installed $1 @ $3"
  fi
}
fetch forge-std foundry-rs/forge-std v1.9.6
fetch openzeppelin-contracts OpenZeppelin/openzeppelin-contracts v5.1.0
ls lib
forge build 2>&1 | tail -n 8
