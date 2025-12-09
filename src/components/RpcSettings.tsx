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
        // We need to wait a tick or just update the input value from the context in next render
        // But we can't easily predict the default value here without importing it or waiting for effect.
        // Simpler: close modal, and let the effect or parent update.
        // However, local state `inputValue` won't update automatically unless we sync it.
        setIsOpen(false);
    };

    // Sync input value when opening
    const handleOpen = () => {
        setInputValue(rpcUrl);
        setIsOpen(true);
    };

    return (
        <div className="relative">
            <button 
                onClick={handleOpen}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isCustom 
                        ? 'bg-yellow-900/30 text-yellow-200 border border-yellow-700/50 hover:bg-yellow-900/50' 
                        : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
                }`}
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10z" clipRule="evenodd" />
                </svg>
                {isCustom ? 'Custom RPC' : 'RPC Settings'}
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-gray-800 rounded-xl shadow-2xl border border-gray-700 p-4 z-50">
                    <h3 className="text-white font-bold mb-2">RPC Connection</h3>
                    <p className="text-xs text-gray-400 mb-3">
                        If you are experiencing rate limits (403/429 errors), try using a custom RPC endpoint (e.g. Helius, QuickNode, Triton).
                    </p>
                    
                    <div className="space-y-3">
                        <div>
                            <label className="block text-xs text-gray-500 uppercase font-bold mb-1">RPC Endpoint URL</label>
                            <input 
                                type="text" 
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500"
                                placeholder="https://api.mainnet-beta.solana.com"
                            />
                        </div>

                        <div className="flex justify-end gap-2 pt-2 border-t border-gray-700">
                            <button 
                                onClick={handleReset}
                                className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                            >
                                Reset Default
                            </button>
                            <button 
                                onClick={handleSave}
                                className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-bold hover:bg-blue-700 transition-colors"
                            >
                                Save
                            </button>
                        </div>
                    </div>
                    
                    {/* Arrow/Backdrop for closing if clicking outside is handled globally, 
                        but here we just have a simple absolute dropdown. 
                        For better UX, a fixed backdrop can close it. */}
                    <div 
                        className="fixed inset-0 -z-10" 
                        onClick={() => setIsOpen(false)} 
                    />
                </div>
            )}
        </div>
    );
};

