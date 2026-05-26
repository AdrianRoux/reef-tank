# Reef Tank App — GitHub Pages Setup Guide

This guide walks you through deploying your reef tank app to GitHub Pages so it's
available at a permanent URL on any device. You'll do this once; future updates
take about thirty seconds.

---

## What you'll need

- A Windows PC
- A GitHub account (free) — create one at https://github.com if you haven't already
- About 20–30 minutes the first time

---

## Step 1 — Install Node.js

Node.js is the tool that builds the app into files a browser can read.

1. Go to https://nodejs.org
2. Download the **LTS** version (the left-hand button, labelled "Recommended for most users")
3. Run the installer — accept all defaults, click Next through every screen
4. When it finishes, open the Start menu, search for **Command Prompt**, and open it
5. Type `node --version` and press Enter. You should see something like `v20.x.x`.
   If you do, Node is installed correctly.

---

## Step 2 — Create a GitHub repository

1. Go to https://github.com and sign in
2. Click the **+** icon in the top-right corner, then **New repository**
3. Name it exactly: `reef-tank` (lowercase, hyphenated — this must match the name in vite.config.js)
4. Leave it set to **Public**
5. Do **not** tick "Add a README file"
6. Click **Create repository**
7. Leave this page open — you'll need the repository URL in a moment

---

## Step 3 — Install Git for Windows

Git is the version-control tool that sends your files to GitHub.

1. Go to https://git-scm.com/download/win
2. Download and run the installer — accept all defaults
3. When done, close and reopen Command Prompt

---

## Step 4 — Place the project files

The `reef-tank` folder (containing `src/`, `index.html`, `package.json`, etc.)
should be somewhere sensible on your PC, for example `C:\Users\YourName\Documents\reef-tank`.

If you received the folder from Cowork, move or copy it to that location now.

---

## Step 5 — Open the project in Command Prompt

In Command Prompt, navigate to the project folder. For example:

```
cd C:\Users\YourName\Documents\reef-tank
```

Replace `YourName` with your actual Windows username.

---

## Step 6 — Install dependencies

Still in Command Prompt, type:

```
npm install
```

This downloads React, Vite, and the deployment tool. It takes a minute or two
and produces a `node_modules` folder. You'll see a lot of text scroll by — that's normal.

---

## Step 7 — Connect your folder to GitHub

You need to do this once to link the folder on your PC to the repository on GitHub.

Type these commands one at a time, pressing Enter after each:

```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/reef-tank.git
git push -u origin main
```

Replace `YOUR-USERNAME` with your actual GitHub username (visible in the URL of
your repository page).

When prompted for a username and password: GitHub no longer accepts your account
password here. Instead, you'll need a Personal Access Token:
- Go to https://github.com/settings/tokens
- Click **Generate new token (classic)**
- Give it a name, set expiry to "No expiration", tick the **repo** checkbox
- Click **Generate token** and copy the token immediately (you won't see it again)
- Use that token as your password in Command Prompt

---

## Step 8 — Deploy to GitHub Pages

Type:

```
npm run deploy
```

This builds the app and pushes the built files to a special branch called `gh-pages`.
You'll see output ending in `Published`.

---

## Step 9 — Enable GitHub Pages in your repository settings

1. Go to your repository on GitHub (https://github.com/YOUR-USERNAME/reef-tank)
2. Click **Settings** (tab along the top)
3. In the left sidebar, click **Pages**
4. Under "Branch", change it from `None` to `gh-pages`, leave the folder as `/ (root)`
5. Click **Save**

GitHub will show a message saying your site is being built. Wait about a minute,
then refresh the page. You'll see a green banner with your live URL:

```
https://YOUR-USERNAME.github.io/reef-tank/
```

Bookmark this on your phone and PC.

---

## Updating the app in future

Whenever you receive an updated `App.jsx` file, replace the one in `src/`, then
open Command Prompt in the project folder and run:

```
npm run deploy
```

That's all. The live URL stays the same.

---

## Troubleshooting

**"npm is not recognised"** — Node.js didn't install correctly. Restart Command Prompt
and try again, or re-run the Node installer.

**The page shows a blank screen or 404** — Check that the `base` value in `vite.config.js`
matches your repository name exactly, including capitalisation. Then run `npm run deploy` again.

**Git asks for a password repeatedly** — Run this once to cache your credentials:
`git config --global credential.helper manager`
