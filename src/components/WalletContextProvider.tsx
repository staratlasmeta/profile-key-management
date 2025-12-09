import { FC, ReactNode, useMemo, useState, createContext, useContext } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';

const RpcContext = createContext<{
    rpcUrl: string;
    setRpcUrl: (url: string) => void;
    resetRpcUrl: () => void;
    isCustom: boolean;
}>({
    rpcUrl: '',
    setRpcUrl: () => {},
    resetRpcUrl: () => {},
    isCustom: false,
});

export const useRpcSettings = () => useContext(RpcContext);

export const WalletContextProvider: FC<{ children: ReactNode }> = ({ children }) => {
    // The network can be set to 'devnet', 'testnet', or 'mainnet-beta'.
    const network = WalletAdapterNetwork.Mainnet;
    const defaultEndpoint = useMemo(() => clusterApiUrl(network), [network]);
    
    const [rpcUrl, setRpcUrlState] = useState(() => {
        return localStorage.getItem('custom_rpc_url') || defaultEndpoint;
    });

    const setRpcUrl = (url: string) => {
        setRpcUrlState(url);
        localStorage.setItem('custom_rpc_url', url);
    };

    const resetRpcUrl = () => {
        setRpcUrlState(defaultEndpoint);
        localStorage.removeItem('custom_rpc_url');
    };

    const wallets = useMemo(
        () => [
            new PhantomWalletAdapter(),
            new SolflareWalletAdapter(),
        ],
        []
    );

    const isCustom = rpcUrl !== defaultEndpoint;

    return (
        <RpcContext.Provider value={{ rpcUrl, setRpcUrl, resetRpcUrl, isCustom }}>
            <ConnectionProvider endpoint={rpcUrl}>
                <WalletProvider wallets={wallets} autoConnect>
                    <WalletModalProvider>
                        {children}
                    </WalletModalProvider>
                </WalletProvider>
            </ConnectionProvider>
        </RpcContext.Provider>
    );
};
