# Upload Instructions for GitHub

## Quick Upload Steps

### Option 1: Using Git (Recommended)

1. **Navigate to package directory:**
   ```bash
   cd open-source/package-v2
   ```

2. **Initialize Git repository:**
   ```bash
   git init
   git add .
   git commit -m "Initial open-source release v5.0.0"
   ```

3. **Add remote and push:**
   ```bash
   git remote add origin https://github.com/yunarax402/yunarax402.git
   git branch -M main
   git push -u origin main
   ```

### Option 2: Using GitHub Web Interface

1. Go to https://github.com/yunarax402/yunarax402
2. Click "Upload files"
3. Drag and drop all files from `open-source/package-v2/`
4. Commit with message: "Initial open-source release v5.0.0"

### Option 3: Using PowerShell Script

Run the upload script:
```powershell
cd open-source\package-v2
.\upload-to-github.ps1
```

Then follow the instructions shown.

## Before Uploading - Final Checklist

- [ ] Review `server.js` - ensure no payment code remains
- [ ] Review `public/script.js` - ensure payment UI removed
- [ ] Review `public/index.html` - ensure payment modal removed
- [ ] Test locally: `npm install && npm start`
- [ ] Verify analysis works without payment
- [ ] Check `.env.example` has all required API keys
- [ ] Verify `README.md` is complete
- [ ] Ensure `LICENSE` file is present
- [ ] Check `.gitignore` excludes sensitive files

## Files to Upload

```
open-source/package-v2/
├── public/              # Frontend files
├── data/               # Empty (with .gitkeep)
├── server.js           # Backend (cleaned)
├── auth.js             # Authentication
├── package.json        # Dependencies
├── env.example         # Environment template
├── README.md           # Documentation
├── LICENSE             # MIT License
├── .gitignore          # Git ignore rules
└── CLEANUP_GUIDE.md    # Cleanup instructions
```

## After Upload

1. Create a GitHub release with tag `v5.0.0`
2. Update repository description
3. Add topics: `crypto`, `blockchain`, `token-analyzer`, `open-source`
4. Enable GitHub Pages if needed
5. Add CONTRIBUTING.md (optional)

