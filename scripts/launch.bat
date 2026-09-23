@echo off
REM DSH Desktop 启动器：双击它就像在命令行跑 `npm start` 一样。
REM 用 %~dp0\.. 定位到项目根，做到随文件夹移动而失效。
set "ROOT=%~dp0.."
cd /d "%ROOT%"
"%ROOT%\node_modules\electron\dist\electron.exe" .
