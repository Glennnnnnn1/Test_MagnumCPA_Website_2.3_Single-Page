@echo off
title Magnum CPA — Sync to GitHub
color 0A

echo ================================================
echo   MAGNUM CPA — GitHub Sync
echo ================================================
echo.

:: Navigate to the project folder
cd /d "C:\Users\Glenn\Documents\Claude\single page magnum"

:: Check if git is installed
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Git is not installed.
    echo Download from: https://git-scm.com/download/win
    pause
    exit /b 1
)

:: Check if this is a git repo — if not, initialize it
if not exist ".git" (
    echo Setting up Git repository for the first time...
    git init
    git remote add origin https://github.com/Glennnnnnn1/Test_MagnumCPA_Website_2.3_Single-Page.git
    git branch -M main
    echo Git initialized!
    echo.
)

:: Stage all changes
echo Staging all changes...
git add .

:: Check if there's anything to commit
git diff --cached --quiet
if %errorlevel% equ 0 (
    echo.
    echo No changes detected — your GitHub is already up to date!
    echo.
    pause
    exit /b 0
)

:: Create commit with timestamp
set TIMESTAMP=%date% %time%
git commit -m "Update site — %TIMESTAMP%"

:: Push to GitHub
echo.
echo Pushing to GitHub...
git push -u origin main

if %errorlevel% equ 0 (
    echo.
    echo ================================================
    echo   SUCCESS! Your site is live on GitHub.
    echo   https://github.com/Glennnnnnn1/Test_MagnumCPA_Website_2.3_Single-Page
    echo ================================================
) else (
    echo.
    echo ERROR: Push failed. See message above.
    echo Common fixes:
    echo   - Run: git remote set-url origin https://github.com/Glennnnnnn1/Test_MagnumCPA_Website_2.3_Single-Page.git
    echo   - Make sure you're logged into GitHub on this machine
)

echo.
pause
