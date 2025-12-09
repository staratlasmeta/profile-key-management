# Profile Key Manager

A web application to view and manage Solana Player Profile keys. Built with React, TypeScript, Vite, Tailwind CSS, and the Star Atlas SDK.

## Features

- **Solana Wallet Connection:** Connect with Phantom, Solflare, and other standard Solana wallets
- **Profile Discovery:** Automatically finds Player Profiles associated with the connected wallet
- **Key Management:**
  - View all keys on a profile (Auth, permissions, expiry)
  - **Delete** non-auth keys
  - **Transfer Authority:** Securely transfer the Auth (Master) key to a new address using a multi-step process that requires signatures from both the current and destination wallets
- **RPC Configuration:** Custom RPC endpoint support to avoid rate limits (useful for Helius, QuickNode, Triton, etc.)
- **Program ID Configuration:** Easily switch between different Player Profile program IDs

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** Tailwind CSS
- **Solana:** 
  - `@solana/wallet-adapter-react`
  - `@solana/wallet-adapter-react-ui`
  - `@solana/wallet-adapter-wallets`
  - `@solana/web3.js`
- **SDKs:** 
  - `@staratlas/player-profile`
  - `@staratlas/anchor`
  - `@staratlas/data-source`
  - `@staratlas/crew`

## Getting Started

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Run Development Server:**
   ```bash
   npm run dev
   ```

3. **Build for Production:**
   ```bash
   npm run build
   ```
   The output will be in the `dist` directory.

4. **Preview Production Build:**
   ```bash
   npm run preview
   ```

## Deployment to GitHub Pages

1. Build the project: `npm run build`
2. Commit the contents of the `dist` folder to a `gh-pages` branch, or configure GitHub Pages to serve from the `dist` folder (if using a workflow) or `docs` folder (if you rename dist to docs).

## Configuration

### Player Profile Program ID

The Player Profile Program ID is configured in `src/utils/constants.ts`.

**Default Program ID:** `pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9`

The application includes quick-select buttons for known program IDs:
- `pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9` (Current default)
- `PprofUW1pURCnMW2si88GWPXEEK3Bvh9Tksy8WtnoYJ` (atlasnet)

You can also manually enter any program ID in the UI.

### RPC Endpoint

The application defaults to the Solana mainnet RPC endpoint. You can configure a custom RPC endpoint via the RPC Settings button in the header to avoid rate limits or use premium RPC providers.

## Transfer Authority Process

The transfer authority feature uses a secure multi-step process:

1. **Enter Destination:** Provide the destination wallet address
2. **Sign with Current Wallet:** The current auth wallet signs the transaction (partial signature)
3. **Connect Destination Wallet:** Switch to and connect the destination wallet
4. **Sign with Destination Wallet:** Complete the transfer by signing with the destination wallet

**Important Notes:**
- Both wallets must be owned by you
- The transaction has a time limit (~42 seconds) to complete both signatures
- A countdown timer shows remaining time during the process
- If the transaction expires, you can restart the process without any changes to your profile

## Project Structure

```
src/
├── components/
│   ├── ProfileManager.tsx    # Main profile management component
│   ├── RpcSettings.tsx       # RPC endpoint configuration
│   └── WalletContextProvider.tsx  # Wallet and RPC context
├── utils/
│   └── constants.ts          # Program IDs and configuration
├── App.tsx                    # Main application component
└── main.tsx                   # Application entry point
```
