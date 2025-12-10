import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { ProfileManager } from './components/ProfileManager';
import { RpcSettings } from './components/RpcSettings';

function App() {
  return (
    <div className="min-h-screen text-[var(--sa-text)] font-primary relative z-10">
      {/* Header */}
      <header className="border-b border-[var(--sa-border)] bg-[var(--sa-black)]/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-3 sm:px-4 md:px-6 h-14 sm:h-16 flex items-center justify-between">
          {/* Logo Section */}
          <div className="flex items-center gap-2 sm:gap-3 md:gap-4 min-w-0 flex-1">
            {/* Logo Icon */}
            <div className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 border border-[var(--sa-accent)] bg-[var(--sa-dark)] flex items-center justify-center relative overflow-hidden group shrink-0">
              <div className="absolute inset-0 bg-gradient-to-br from-[rgb(var(--sa-accent-rgb-space))]/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 sm:w-4.5 sm:h-4.5 md:w-5 md:h-5 text-[var(--sa-accent)] relative z-10">
                <path fillRule="evenodd" d="M12.516 2.17a.75.75 0 00-1.032 0 11.209 11.209 0 01-7.877 3.08.75.75 0 00-.722.515A12.74 12.74 0 002.5 9.75c0 5.992 3.043 11.294 7.923 14.07a.75.75 0 00.755 0C16.057 21.045 19.1 15.742 19.1 9.75c0-1.408-.255-2.766-.722-4.045a.75.75 0 00-.722-.515 11.208 11.208 0 01-7.877-3.08z" clipRule="evenodd" />
              </svg>
              {/* Ping indicator */}
              <div className="absolute top-0.5 right-0.5 sm:top-1 sm:right-1 w-1.5 h-1.5 sm:w-2 sm:h-2 bg-[var(--sa-accent)] animate-pulse"></div>
            </div>
            
            {/* Title */}
            <div className="flex flex-col min-w-0">
              <h1 className="font-mono text-xs sm:text-sm md:text-base lg:text-lg font-bold tracking-wide sm:tracking-wider text-[var(--sa-text)] hover:text-[var(--sa-accent)] transition-colors cursor-default truncate">
                PROFILE KEY MANAGER
              </h1>
              <span className="font-mono text-[8px] sm:text-[9px] md:text-[10px] text-[var(--sa-text-dim)] tracking-wide sm:tracking-[0.2em] uppercase hidden sm:block">
                Star Atlas // Key Management
              </span>
            </div>
          </div>
          
          {/* Controls */}
          <div className="flex items-center gap-2 sm:gap-3 md:gap-4 shrink-0">
            {/* System Status */}
            <div className="hidden lg:flex items-center gap-2 px-2 sm:px-3 py-1 sm:py-1.5 bg-[var(--sa-dark)] border border-[var(--sa-border)]">
              <div className="status-indicator active"></div>
              <span className="font-mono text-[9px] sm:text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider whitespace-nowrap">System Online</span>
            </div>
            
            <RpcSettings />
            <WalletMultiButton />
          </div>
        </div>
        
        {/* Accent line */}
        <div className="h-[1px] bg-gradient-to-r from-transparent via-[var(--sa-accent)] to-transparent opacity-50"></div>
      </header>

      {/* Main Content */}
      <main className="py-8 relative">
        <ProfileManager />
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--sa-border)] mt-auto py-8 bg-[var(--sa-black)]/50 backdrop-blur-sm">
        <div className="container mx-auto px-6">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            {/* Left side */}
            <div className="flex items-center gap-6">
              <span className="font-mono text-[10px] text-[var(--sa-text-dim)] tracking-wider opacity-50 hover:opacity-100 transition-opacity">
                SYSTEM /// ONLINE
              </span>
              <span className="font-mono text-[10px] text-[var(--sa-accent)] tracking-wider">
                v1.0.0
              </span>
            </div>
            
            {/* Center */}
            <p className="font-mono text-[11px] text-[var(--sa-text-dim)] tracking-wide">
              &copy; {new Date().getFullYear()} Profile Key Manager • Star Atlas Tools
            </p>
            
            {/* Right side */}
            <div className="font-mono text-[10px] text-[var(--sa-text-dim)] tracking-wider">
              <span className="opacity-50">Powered by</span>{' '}
              <span className="text-[var(--sa-accent)]">Solana</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
