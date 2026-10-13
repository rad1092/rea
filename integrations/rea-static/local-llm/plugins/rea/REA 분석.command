#!/bin/zsh
set -eu
REA_PLUGIN_DIRECTORY="${0:A:h}"
REA_PROJECT_DIRECTORY="${REA_PLUGIN_DIRECTORY:h:h}"
REA_PYTHON="${REA_PROJECT_DIRECTORY}/venvs/broker/bin/python"
if [[ ! -x "${REA_PYTHON}" ]]; then
  print -u2 '로컬 AI의 기존 Python 실행 환경을 찾지 못했습니다.'
  exit 1
fi
cd "${REA_PROJECT_DIRECTORY}"
"${REA_PYTHON}" "${REA_PROJECT_DIRECTORY}/scripts/rea_assistant.py" \
  --config "${REA_PROJECT_DIRECTORY}/runtime/rea.local.json" --interactive
