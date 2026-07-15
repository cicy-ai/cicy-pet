@echo off
chcp 65001 >nul
title CiCy Pet - 更新并启动
setlocal

REM ── CN 加速：Electron 二进制走 OSS 镜像，npm 走淘宝源 ──
set ELECTRON_MIRROR=https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com/electron/
set npm_config_registry=https://registry.npmmirror.com

REM 源码放在本 .bat 同目录下的 cicy-pet 文件夹
cd /d "%~dp0"

where git >nul 2>nul || (echo [X] 没装 git，先装：https://git-scm.com/ ^& pause ^& exit /b 1)
where node >nul 2>nul || (echo [X] 没装 Node.js，先装：https://nodejs.org/ ^& pause ^& exit /b 1)

if exist cicy-pet\.git (
  echo == 拉取最新源码 ==
  cd cicy-pet
  git pull
) else (
  echo == 首次克隆 ==
  git clone https://github.com/cicy-ai/cicy-pet.git cicy-pet || (echo [X] 克隆失败 ^& pause ^& exit /b 1)
  cd cicy-pet
)

echo == 安装依赖（首次较慢，Electron 走 OSS 镜像）==
call npm install || (echo [X] npm install 失败 ^& pause ^& exit /b 1)

echo == 启动 CiCy Pet ==
call npm start

pause
