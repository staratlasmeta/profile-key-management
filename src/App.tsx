import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { ProfileManager } from './components/ProfileManager';
import { RpcSettings } from './components/RpcSettings';

function App() {
  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans selection:bg-blue-500 selection:text-white">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                <path fillRule="evenodd" d="M12.516 2.17a.75.75 0 00-1.032 0 11.209 11.209 0 01-7.877 3.08.75.75 0 00-.722.515A12.74 12.74 0 002.5 9.75c0 5.992 3.043 11.294 7.923 14.07a.75.75 0 00.755 0C16.057 21.045 19.1 15.742 19.1 9.75c0-1.408-.255-2.766-.722-4.045a.75.75 0 00-.722-.515 11.208 11.208 0 01-7.877-3.08zM12 4.198a9.718 9.718 0 005.602 2.095c.32.935.504 1.927.538 2.957h-1.996a.75.75 0 000 1.5h1.984a11.232 11.232 0 01-1.31 4.5h-3.318a.75.75 0 000 1.5h2.696c-1.66 2.32-4.072 3.963-6.196 4.86C7.21 20.516 4 16.154 4 9.75c0-1.032.185-2.025.505-2.96h1.995a.75.75 0 000-1.5H4.514c.32-.932.697-1.829 1.117-2.697A9.72 9.72 0 0012 4.198z" clipRule="evenodd" />
              </svg>
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
              Profile Key Manager
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <RpcSettings />
            <WalletMultiButton className="!bg-blue-600 hover:!bg-blue-700 !transition-colors !rounded-lg !px-6" />
          </div>
        </div>
      </header>

      <main className="py-8">
        <ProfileManager />
      </main>

      <footer className="border-t border-gray-800 mt-auto py-6">
        <div className="container mx-auto px-4 text-center text-gray-500 text-sm">
          <p>&copy; {new Date().getFullYear()} Profile Key Manager. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}

export default App

