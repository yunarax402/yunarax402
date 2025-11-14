# GitHub Upload Commands

## Quick Upload to GitHub

### Step 1: Navigate to Package Directory
```bash
cd open-source/package-v2
```

### Step 2: Initialize Git (if not already done)
```bash
git init
```

### Step 3: Add All Files
```bash
git add .
```

### Step 4: Commit
```bash
git commit -m "Initial open-source release v5.0.0 - No payment system, users provide own API keys"
```

### Step 5: Add Remote
```bash
git remote add origin https://github.com/yunarax402/yunarax402.git
```

### Step 6: Push to GitHub
```bash
git branch -M main
git push -u origin main
```

## If Repository Already Exists

If the repository already has content:

```bash
# Add remote
git remote add origin https://github.com/yunarax402/yunarax402.git

# Pull existing content (if any)
git pull origin main --allow-unrelated-histories

# Push
git push -u origin main
```

## Force Push (Use with Caution)

If you need to overwrite existing content:

```bash
git push -u origin main --force
```

## Alternative: Using GitHub CLI

If you have GitHub CLI installed:

```bash
gh repo create yunarax402/yunarax402 --public --source=. --remote=origin --push
```

## Verification

After uploading, verify:
1. All files are present on GitHub
2. README.md displays correctly
3. No sensitive data (API keys, passwords) in files
4. .gitignore is working

## Next Steps After Upload

1. Add repository description: "Multi-Chain Launchpad Analyzer - Open Source"
2. Add topics: `crypto`, `blockchain`, `token-analyzer`, `open-source`, `ai`, `trading`
3. Enable GitHub Pages (if needed)
4. Create first release: `v5.0.0`

