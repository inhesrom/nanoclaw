#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi
if [ "$(uname -m)" != "aarch64" ]; then
  echo "Moonshine candidate installation requires aarch64" >&2
  exit 1
fi
command -v python3.13 >/dev/null

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_dir=/opt/nanoclaw/moonshine-0.0.69
server_dir=/opt/nanoclaw/moonshine-server
model_dir=/var/lib/nanoclaw/stt/moonshine-streaming-small-en
candidate_profile=/var/lib/nanoclaw/stt/candidate-profile.json

if [ -e "$runtime_dir" ] || [ -e "$model_dir" ]; then
  echo "candidate runtime or model path already exists; refusing to overwrite" >&2
  exit 1
fi

getent group nanoclaw-stt >/dev/null || groupadd --system nanoclaw-stt
id nanoclaw-stt >/dev/null 2>&1 || \
  useradd --system --gid nanoclaw-stt --no-create-home --home-dir /nonexistent nanoclaw-stt
install -d -o root -g root -m 0755 /opt/nanoclaw "$server_dir"
install -d -o root -g nanoclaw-stt -m 0750 /var/lib/nanoclaw/stt

python3.13 -m venv "$runtime_dir"
"$runtime_dir/bin/python" -m pip install \
  --require-hashes --only-binary=:all: \
  -r "$script_dir/requirements-aarch64-py313.lock"
install -o root -g root -m 0555 "$script_dir/moonshine_server.py" \
  "$server_dir/moonshine_server.py"
install -o root -g root -m 0444 \
  "$script_dir/requirements-aarch64-py313.lock" \
  "$server_dir/requirements-aarch64-py313.lock"

download_dir=$(mktemp -d /var/lib/nanoclaw/stt/.moonshine-download.XXXXXX)
cleanup() {
  rm -rf -- "$download_dir"
}
trap cleanup EXIT INT TERM
"$runtime_dir/bin/python" -m moonshine_voice.download \
  --stt --language en --model-arch 4 --root "$download_dir"
source_model="$download_dir/download.moonshine.ai/model/small-streaming-en/quantized"
install -d -o root -g nanoclaw-stt -m 0750 "$model_dir"
for component in \
  adapter.ort cross_kv.ort decoder_kv.ort decoder_kv_with_attention.ort \
  encoder.ort frontend.ort streaming_config.json tokenizer.bin
do
  install -o root -g nanoclaw-stt -m 0440 \
    "$source_model/$component" "$model_dir/$component"
done

node "$script_dir/render-profile.mjs" \
  "$model_dir" "$runtime_dir" "$server_dir/moonshine_server.py" \
  "$server_dir/requirements-aarch64-py313.lock" "$candidate_profile" candidate
chown root:nanoclaw-stt "$candidate_profile"
chmod 0640 "$candidate_profile"

echo "Candidate installed. Run Gate 1 against $candidate_profile before enabling systemd." >&2
