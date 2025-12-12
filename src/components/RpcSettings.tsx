import { useState } from 'react';
import { useRpcSettings } from './WalletContextProvider';

export const RpcSettings = () => {
    const { rpcUrl, setRpcUrl, resetRpcUrl, isCustom } = useRpcSettings();
    const [isOpen, setIsOpen] = useState(false);
    const [inputValue, setInputValue] = useState(rpcUrl);

    const handleSave = () => {
        if (inputValue.trim()) {
            setRpcUrl(inputValue.trim());
            setIsOpen(false);
        }
    };

    const handleReset = () => {
        resetRpcUrl();
        setIsOpen(false);
    };

    // Sync input value when opening
    const handleOpen = () => {
        setInputValue(rpcUrl);
        setIsOpen(true);
    };

    return (
        <>
            <button 
                onClick={handleOpen}
                className={`flex items-center gap-2 px-4 py-2.5 border font-mono text-sm font-bold uppercase tracking-wider transition-all ${
                    isCustom 
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20 hover:border-amber-500/50' 
                        : 'bg-[var(--sa-dark)] text-[var(--sa-text-dim)] border-[var(--sa-border)] hover:text-[var(--sa-text)] hover:border-[var(--sa-accent)]'
                }`}
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10z" clipRule="evenodd" />
                </svg>
                {isCustom ? 'CUSTOM RPC' : 'RPC'}
            </button>

            {/* Full-screen modal instead of dropdown */}
            {isOpen && (
                <div 
                    className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-start justify-center z-50 p-4 pt-[160px]"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setIsOpen(false);
                        }
                    }}
                >
                    <div className="sage-card p-6 w-full max-w-md border-[rgb(var(--sa-accent-rgb-space))]/30 max-h-[calc(100vh-180px)] overflow-y-auto">
                        <div className="flex items-center gap-2 mb-4">
                            <span className="font-mono text-sm text-[var(--sa-accent)] font-bold tracking-wider">CONFIG</span>
                            <h3 className="font-mono text-base font-bold tracking-wider text-[var(--sa-text)]">RPC CONNECTION</h3>
                        </div>
                        <p className="font-mono text-sm text-[var(--sa-text-dim)] tracking-wide mb-4 leading-relaxed">
                            If experiencing rate limits (403/429), use a custom RPC endpoint (Helius, QuickNode, Triton).
                        </p>
                        
                        <div className="space-y-4">
                            <div>
                                <label className="block font-mono text-sm text-[var(--sa-text-dim)] uppercase tracking-wider font-bold mb-2">RPC Endpoint URL</label>
                                <input 
                                    type="text" 
                                    value={inputValue}
                                    onChange={(e) => setInputValue(e.target.value)}
                                    className="sage-input"
                                    placeholder="https://api.mainnet-beta.solana.com"
                                />
                            </div>

                            {/* Current status */}
                            <div className="bg-[var(--sa-black)] border border-[var(--sa-border)] p-3">
                                <label className="block font-mono text-sm text-[var(--sa-text-dim)] uppercase tracking-wider mb-2">Current Status</label>
                                <div className="flex items-center gap-2">
                                    <div className={`status-indicator ${isCustom ? 'active' : ''}`} style={{ background: isCustom ? '#f59e0b' : undefined }}></div>
                                    <span className={`font-mono text-sm ${isCustom ? 'text-amber-400' : 'text-[var(--sa-text-dim)]'}`}>
                                        {isCustom ? 'Custom RPC Active' : 'Default RPC'}
                                    </span>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 pt-4 border-t border-[var(--sa-border)]">
                                <button 
                                    onClick={() => setIsOpen(false)}
                                    className="sage-button-secondary px-4 py-2.5"
                                >
                                    CANCEL
                                </button>
                                <button 
                                    onClick={handleReset}
                                    className="sage-button-secondary px-4 py-2.5"
                                >
                                    RESET DEFAULT
                                </button>
                                <button 
                                    onClick={handleSave}
                                    className="sage-button px-4 py-2.5"
                                >
                                    SAVE
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
