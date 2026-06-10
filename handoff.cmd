@echo off
:: End-of-session handoff: commit and push everything to GitHub main.
:: Run this before closing a local work session so cloud sessions can pull it.
cd /d "%~dp0"

git diff --quiet && git diff --cached --quiet
if %errorlevel%==0 (
  git ls-files --others --exclude-standard | findstr . >nul
  if errorlevel 1 (
    echo Working tree is clean - nothing to hand off.
    git push origin main
    pause
    exit /b 0
  )
)

set msg=handoff: local session work %date% %time%
set /p msg=Commit message [%msg%]:

echo Staging and committing...
git add -A
git commit -m "%msg%"

echo Pushing to GitHub...
git push origin main
if errorlevel 1 (
  echo Push rejected - main moved. Rebasing and retrying...
  git pull --rebase origin main
  git push origin main
)

echo.
echo Done. Now at:
git log --oneline -1
pause
