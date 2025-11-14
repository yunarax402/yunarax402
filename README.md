# YunaraX402 - Open Source Version

![YunaraX402 Banner](https://raw.githubusercontent.com/yunarax402/yunarax402/main/public/banner.jpg)

> **Multi-Chain Launchpad Analyzer with AI Trading Assistant**

Search - Analyze - Measure - Invest

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Real-time Token Discovery**: Discover new tokens across Solana, Base, Ethereum, and BNB Chain
- **AI-Powered Analysis**: Comprehensive token analysis using Gemini AI, OpenAI, and Grok
- **Multi-Chain Support**: Analyze tokens on Solana, Base, Ethereum, and BNB Chain
- **Twitter/X Integration**: Community sentiment analysis via Grok API
- **Holder Statistics**: Deep dive into token holder distribution and acquisition patterns
- **Security Analysis**: RugCheck integration for Solana token security scoring
- **AI Chat Assistant**: Interactive trading assistant powered by Moralis AI, Gemini, and Grok

## Quick Start

### Prerequisites

- Node.js 16+ and npm
- Moralis API key (required)
- At least one AI API key: Gemini (recommended), OpenAI, or Grok

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yunarax402/yunarax402.git
   cd yunarax402
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp env.example .env
   ```
   
   Edit `.env` and add your API keys:
   - `MORALIS_API_KEY` (required) - Get from [Moralis.io](https://moralis.io)
   - `GEMINI_API_KEY` (recommended) - Get from [Google AI Studio](https://makersuite.google.com/app/apikey)
   - `OPENAI_API_KEY` (optional) - Get from [OpenAI Platform](https://platform.openai.com/api-keys)
   - `GROK_API_KEY` (optional) - Get from [X.ai](https://x.ai/api)

4. **Start the server**
   ```bash
   npm run dev    # Development mode with auto-reload
   # or
   npm start      # Production mode
   ```

5. **Open your browser**
   ```
   http://localhost:3000
   ```

## Environment Variables

See `env.example` for all available configuration options.

### Required
- `MORALIS_API_KEY` - Moralis API key for blockchain data

### Recommended
- `GEMINI_API_KEY` - Google Gemini API for AI analysis
- `GROK_API_KEY` - X.ai Grok API for Twitter sentiment analysis

### Optional
- `OPENAI_API_KEY` - OpenAI API (fallback if Gemini fails)
- `TWITTER_API_KEY` - Twitter API for quest verification
- `HELIUS_API_KEY` - Enhanced Solana metadata
- `RUGCHECK_API_KEY` - Solana token security analysis
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - For user authentication

## Project Structure

```
yunarax402/
├── public/                     # Frontend assets (HTML, CSS, JS, media)
│   ├── index.html              # Main application page
│   ├── style.css               # Styles
│   └── script.js               # Frontend logic
├── data/                       # User data storage (created at runtime)
├── server.js                   # Express backend with AI routes
├── auth.js                     # Google OAuth authentication
├── package.json                # Dependencies
├── env.example                 # Environment variables template
└── README.md                   # This document
```

## API Endpoints

### Token Analysis
- `POST /api/analyze` - Analyze a token (requires authentication - optional)
- `GET /api/search` - Search for tokens by address, name, or symbol
- `GET /api/token/:chain/:address` - Get token details

### AI Chat
- `POST /api/ai-chat` - Chat with AI trading assistant (full features for all users)

### Authentication (Optional)
- `GET /api/auth/google` - Google OAuth login
- `GET /api/auth/logout` - Logout
- `GET /api/user` - Get current user info

## Usage

### Analyze a Token

1. Search for a token by address, name, or symbol
2. Click "Analyze" on any token
3. Get comprehensive AI-powered analysis including:
   - Risk assessment
   - Security analysis
   - Market analysis
   - Tokenomics & fundamentals
   - Twitter/community insights (if Grok API is configured)
   - Trading recommendations

### AI Chat Assistant

Use the chat widget to ask questions about:
- Token analysis
- Trading strategies
- Market trends
- Blockchain concepts

**Note:** In the open-source version, all users get full AI chat features (no PRO mode restrictions).

## Authentication

Authentication is optional. Without Google OAuth configured:
- You can still browse and search tokens
- Analysis features work without login
- Some features may be limited

To enable authentication:
1. Create OAuth credentials at [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.env`
3. Set `GOOGLE_CALLBACK_URL` to your domain

## Deployment

### Local Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### Using PM2
```bash
npm install -g pm2
pm2 start server.js --name yunarax402
pm2 save
pm2 startup
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Moralis](https://moralis.io) - Blockchain data API
- [Google Gemini](https://deepmind.google/technologies/gemini/) - AI analysis
- [OpenAI](https://openai.com) - AI fallback
- [X.ai Grok](https://x.ai) - Twitter sentiment analysis

## Support

- Website: [https://yunarax402.com](https://yunarax402.com)
- GitHub: [https://github.com/yunarax402/yunarax402](https://github.com/yunarax402/yunarax402)
- Twitter: [@YunaraX402](https://twitter.com/YunaraX402)

## Disclaimer

This software is provided for educational and research purposes. Always do your own research (DYOR) before making any investment decisions. Cryptocurrency trading involves substantial risk of loss.

---

Made with love by the YunaraX402 team
