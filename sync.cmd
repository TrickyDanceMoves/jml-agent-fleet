@echo off
:: Sync this clone to the latest GitHub main, discarding any local edits.
:: Close the JML Console app first - OneDrive file locks can block the reset.
cd /d "%~dp0"
echo Fetching latest from GitHub...
git fetch origin
echo Resetting to origin/main (local uncommitted edits will be discarded)...
git reset --hard origin/main
echo.
echo Done. Now at:
git log --oneline -1
pause
