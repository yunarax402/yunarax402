# Quick Start Guide

## Installation

```bash
# Clone the repository
git clone https://github.com/yunarax402/yunarax402.git
cd yunarax402

# Install dependencies
npm install

# Configure environment
cp env.example .env
# Edit .env and add your API keys

# Start the server
npm run dev    # Development mode
# or
npm start      # Production mode
```

## Required API Keys

At minimum, you need:
- `MORALIS_API_KEY` - Get from https://moralis.io
- `GEMINI_API_KEY` - Get from https://makersuite.google.com/app/apikey

Optional but recommended:
- `GROK_API_KEY` - For Twitter sentiment analysis
- `OPENAI_API_KEY` - Fallback AI provider

## First Run

1. Start the server: `npm start`
2. Open browser: `http://localhost:3000`
3. Search for a token
4. Click "Analyze" - should work immediately (no payment required)

## Troubleshooting

**Analysis fails:**
- Check your API keys in `.env`
- Verify `MORALIS_API_KEY` is valid
- Verify `GEMINI_API_KEY` or `OPENAI_API_KEY` is set

**Server won't start:**
- Check Node.js version: `node --version` (needs 16+)
- Run `npm install` again
- Check for errors in console

**No data showing:**
- Verify Moralis API key is working
- Check network tab in browser for API errors

