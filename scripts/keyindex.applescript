-- Cabin Music: runs the BPM/key indexer. An app (not node itself) holds Full Disk Access, so it
-- keeps working when Homebrew updates node; /opt/homebrew/bin/node always points at the current one.
do shell script "cd '/Users/stefansegers/docker/cabin-music' && PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin /opt/homebrew/bin/node scripts/keyindex.mjs >> \"$HOME/Library/Logs/cabin-keyindex.log\" 2>&1"
