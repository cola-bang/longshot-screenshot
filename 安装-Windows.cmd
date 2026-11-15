@echo off
chcp 936 >nul 2>&1
setlocal
title LongShot 长截图 - 安装助手

set "SRC=%~dp0longshot"
set "DEST=%LOCALAPPDATA%\LongShot\extension"
set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"

echo ==================================================
echo    LongShot 长截图  v1.2.1   安装助手
echo ==================================================
echo.

if not exist "%SRC%\manifest.json" (
  echo  [X] 没有找到 longshot 文件夹。
  echo      请先对着压缩包右键 - 全部解压缩，再双击本文件。
  echo.
  pause
  exit /b 1
)

echo  [1/3] 复制扩展文件到固定目录...
if exist "%DEST%" rd /s /q "%DEST%"
mkdir "%DEST%" >nul 2>&1
xcopy "%SRC%\*" "%DEST%\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo  [X] 复制失败，请检查写入权限。
  echo.
  pause
  exit /b 1
)
echo        完成：%DEST%
echo.

set "BROWSER="
set "BNAME="
call :try "%PF86%\Microsoft\Edge\Application\msedge.exe"
call :try "%PF%\Microsoft\Edge\Application\msedge.exe"
call :try "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
call :try "%PF%\Google\Chrome\Application\chrome.exe"
call :try "%PF86%\Google\Chrome\Application\chrome.exe"
call :try "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
call :try "%PF%\BraveSoftware\Brave-Browser\Application\brave.exe"
goto :browser_ready

:try
if defined BROWSER goto :eof
if not exist "%~1" goto :eof
set "BROWSER=%~1"
set "BNAME=%~nx1"
goto :eof

:browser_ready
set "EXTURL=chrome://extensions"
if /i "%BNAME%"=="msedge.exe" set "EXTURL=edge://extensions"
if /i "%BNAME%"=="brave.exe" set "EXTURL=brave://extensions"

echo  [2/3] 打开扩展管理页与扩展文件夹...
if defined BROWSER (
  start "" "%BROWSER%" "%EXTURL%"
) else (
  echo        没检测到 Edge / Chrome，请手动打开浏览器的扩展管理页。
)
start "" explorer.exe /select,"%DEST%"
echo.

echo  [3/3] 在弹出的页面里做两步：
echo        1) 右上角打开「开发者模式」
echo        2) 点左上角「加载未打包的扩展程序」，选中刚弹出的文件夹
echo.
echo  装好后点工具栏的拼图图标，把「长截图 LongShot」固定出来即可使用。
echo  更新版本：重新解压覆盖后再运行一次本文件，然后到扩展页点「刷新」。
echo.
pause
