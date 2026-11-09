#!/bin/sh
set -e

# 建表 + 导入题目（幂等，重复执行不会重复插入）
python seed.py

exec uvicorn main:app --host 0.0.0.0 --port 8000
